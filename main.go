package main

import (
	"context"
	"embed"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/windows/icon.ico
var trayIconBytes []byte // Windows 托盘要求 .ico 格式

// nativeTheme 原生标题栏配色，和页面主题保持一致（COLORREF: 0x00BBGGRR）
// 暗色：#2a2b2d 底 / #dcdcdc 字 / #48494d 边框；亮色：#ffffff 底 / #333333 字 / #e5e5e5 边框
var nativeTheme = &windows.ThemeSettings{
	DarkModeTitleBar:           0x002D2B2A,
	DarkModeTitleBarInactive:   0x002D2B2A,
	DarkModeTitleText:          0x00DCDCDC,
	DarkModeTitleTextInactive:  0x00DCDCDC,
	DarkModeBorder:             0x004D4948,
	DarkModeBorderInactive:     0x004D4948,
	LightModeTitleBar:          0x00FFFFFF,
	LightModeTitleBarInactive:  0x00FFFFFF,
	LightModeTitleText:         0x00333333,
	LightModeTitleTextInactive: 0x00333333,
	LightModeBorder:            0x00E5E5E5,
	LightModeBorderInactive:    0x00E5E5E5,
}

// 欢迎页（工作区选择页）窗口尺寸，与前端 PICKER_WIDTH/HEIGHT 保持一致
const (
	pickerWindowWidth  = 430
	pickerWindowHeight = 470
)

// viewerMode 图片查看器进程模式（--image-viewer 启动时为 true）
var viewerMode = false

// forceQuit 托盘退出/用户确认退出时置位，绕过关闭拦截
var forceQuit = false

// singleInstanceAddr 单实例通信地址：第二实例通过 HTTP 通知第一实例后退出
const singleInstanceAddr = "127.0.0.1:27182"

// localFileHandler 提供本地磁盘文件预览：
// /local-file?path=<绝对路径> 用于在编辑器/查看器中显示本地图片
func localFileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/local-file" {
			http.NotFound(w, r)
			return
		}
		p := r.URL.Query().Get("path")
		if p == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, filepath.Base(p), time.Time{}, f)
	})
}

// notifyExistingInstance 尝试通知已在运行的实例唤出窗口。
// 校验专属响应头，防止端口被其他程序或调试残留进程占用时被误劫持。
func notifyExistingInstance() bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + singleInstanceAddr + "/show")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK &&
		resp.Header.Get("X-Typora-Lite") == "pong"
}

// runTray 系统托盘：显示主窗口 / 完全退出
func runTray(ctx context.Context, a *App) {
	systray.Run(func() {
		systray.SetIcon(trayIconBytes)
		systray.SetTooltip("LiteMark Note")
		systray.SetTitle("LiteMark Note")
		mShow := systray.AddMenuItem("显示主窗口", "显示编辑器窗口")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("退出 LiteMark Note", "完全退出软件")
		showFromTray := func() {
			if ctx != nil {
				forceQuit = false
				a.showMainWindow()
			}
		}
		// 双击托盘图标唤出主窗口
		systray.SetOnDClick(func(menu systray.IMenu) { showFromTray() })
		mShow.Click(showFromTray)
		mQuit.Click(func() {
			forceQuit = true
			if ctx != nil {
				wailsruntime.Quit(ctx)
			} else {
				os.Exit(0)
			}
		})
	}, nil)
}

// Viewer 图片查看器窗口的绑定
type Viewer struct {
	ctx  context.Context
	path string
}

func (v *Viewer) startup(ctx context.Context) { v.ctx = ctx }

// ImagePath 返回要查看的图片绝对路径
func (v *Viewer) ImagePath() string { return v.path }

// runImageViewer 以独立窗口模式运行图片查看器
func runImageViewer(path string) {
	v := &Viewer{path: path}

	// 查看器窗口主题跟随设置
	winTheme := windows.Dark
	if loadSettings().Theme == "light" {
		winTheme = windows.Light
	}

	err := wails.Run(&options.App{
		Title:  "图片查看 - " + filepath.Base(path),
		Width:  960,
		Height: 720,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Handler:    localFileHandler(),
			Middleware: viewerAssetMiddleware,
		},
		OnStartup: v.startup,
		Bind: []interface{}{
			v,
		},
		Windows: &windows.Options{
			Theme:       winTheme,
			CustomTheme: nativeTheme,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// viewerAssetMiddleware 把查看器进程的根路径请求重写到 viewer.html
func viewerAssetMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if viewerMode && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			r.URL.Path = "/viewer.html"
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// 查看器模式：LiteMarkNote.exe --image-viewer <图片路径>
	args := os.Args[1:]
	if len(args) >= 2 && args[0] == "--image-viewer" {
		viewerMode = true
		runImageViewer(args[1])
		return
	}

	// 单实例：尝试占用通信端口；被占用说明已有实例运行，唤出它的窗口即可
	ln, err := net.Listen("tcp", singleInstanceAddr)
	if err != nil {
		if notifyExistingInstance() {
			return
		}
		ln = nil
	}

	app := NewApp()
	app.ln = ln

	// 原生窗口主题跟随设置（默认暗色）
	winTheme := windows.Dark
	if app.settings.Theme == "light" {
		winTheme = windows.Light
	}

	err = wails.Run(&options.App{
		Title:  "LiteMark Note",
		Width:  pickerWindowWidth,
		Height: pickerWindowHeight,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true, // 文件拖放统一由 wails 事件处理，避免 webview 直接打开
		},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Handler:    localFileHandler(),
			Middleware: viewerAssetMiddleware,
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			Theme:                winTheme,
			CustomTheme:          nativeTheme,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
	if ln != nil {
		ln.Close()
	}
}
