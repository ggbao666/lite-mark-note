package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// FileData 前后端之间传递的文件内容
type FileData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SaveImageResult 图片落盘结果
type SaveImageResult struct {
	Path string `json:"path"` // 落盘绝对路径
	Src  string `json:"src"`  // markdown 中的引用路径（正斜杠；相对模式下是相对当前文件的路径）
}

// App 应用主体，负责文件对话框与读写
type App struct {
	ctx         context.Context
	curPath     string // 当前打开的笔记路径，空表示未打开笔记
	workspace   string // 当前工作区根目录
	ln          net.Listener
	settings    Settings // 应用设置
	resetOnShow bool     // 关闭到后台后，下次显示窗口时回到工作区选择页
}

func NewApp() *App {
	return &App{settings: loadSettings()}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.ln != nil {
		go a.serveSingleInstance()
	}
	go runTray(ctx, a)
}

// beforeClose 拦截窗口关闭：先交给前端处理未保存内容，再决定退出 / 留在后台
func (a *App) beforeClose(ctx context.Context) bool {
	if forceQuit {
		return false
	}
	runtime.EventsEmit(ctx, "close-requested", a.ln != nil)
	return true
}

// ConfirmClose 前端关闭询问的结果
func (a *App) ConfirmClose(action string, remember bool) {
	if remember && (action == "exit" || action == "background") {
		a.settings.CloseAction = action
		_ = saveSettingsToDisk(a.settings)
	}
	// 附属窗口实例（无托盘）只能退出，不能藏起来
	if action == "exit" || a.ln == nil {
		forceQuit = true
		runtime.Quit(a.ctx)
		return
	}
	a.resetOnShow = true
	runtime.WindowHide(a.ctx)
}

// showMainWindow 显示主窗口；若是“关闭到后台”后重开，则让前端回到启动页
func (a *App) showMainWindow() {
	reset := a.resetOnShow
	a.resetOnShow = false
	runtime.EventsEmit(a.ctx, "window-shown", reset)
	runtime.WindowShow(a.ctx)
}

// serveSingleInstance 单实例服务：接收第二实例的唤出窗口请求
func (a *App) serveSingleInstance() {
	mux := http.NewServeMux()
	mux.HandleFunc("/show", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Typora-Lite", "pong")
		a.showMainWindow()
		w.WriteHeader(http.StatusOK)
	})
	_ = http.Serve(a.ln, mux)
}

// ImportImage 把磁盘上的图片文件导入资源目录（拖拽图片进编辑器）
func (a *App) ImportImage(path string) (*SaveImageResult, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			ext = ".jpg"
		}
	default:
		return nil, fmt.Errorf("不支持的图片格式: %s", ext)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return a.saveToAssets(data, ext)
}

// ---------- 设置 ----------

// GetSettings 读取设置
func (a *App) GetSettings() Settings {
	return a.settings
}

// SaveSettings 保存设置并持久化
func (a *App) SaveSettings(s Settings) (Settings, error) {
	if s.AssetsFolder == "" {
		s.AssetsFolder = "assets"
	}
	if s.AssetMode != "custom" && s.AssetMode != "relative" {
		s.AssetMode = "relative"
	}
	if s.CloseAction == "" {
		// 前端保存其他设置时未带此字段 → 保留原有选择
		s.CloseAction = a.settings.CloseAction
	}
	if s.CloseAction != "exit" && s.CloseAction != "background" {
		s.CloseAction = "ask"
	}
	if s.Theme != "light" {
		s.Theme = "dark"
	}
	// 工作区字段由 OpenWorkspace 维护，前端保存其它设置时不能覆盖丢失
	if s.LastWorkspace == "" {
		s.LastWorkspace = a.settings.LastWorkspace
	}
	if len(s.RecentWorkspaces) == 0 {
		s.RecentWorkspaces = a.settings.RecentWorkspaces
	}
	a.settings = s
	if err := saveSettingsToDisk(s); err != nil {
		return s, err
	}
	// 主题变化时同步原生窗口边框（顶部标题栏/最小化按钮那排）
	if a.ctx != nil {
		if s.Theme == "light" {
			runtime.WindowSetLightTheme(a.ctx)
		} else {
			runtime.WindowSetDarkTheme(a.ctx)
		}
	}
	return s, nil
}

// ChooseDirectory 弹出选择目录对话框
func (a *App) ChooseDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择图片资源存储目录",
	})
}

// ---------- 图片存储 ----------

// resolveAssetsDir 按设置决定图片落盘目录
func (a *App) resolveAssetsDir() string {
	s := a.settings
	if s.AssetMode == "custom" && s.CustomDir != "" {
		return s.CustomDir
	}
	if a.curPath != "" {
		return filepath.Join(filepath.Dir(a.curPath), s.AssetsFolder)
	}
	// relative 模式但当前文件未保存 → 软件默认资源目录
	return DefaultAssetsDir()
}

// timeImageName 统一按时间命名：20261104-153045.png，同秒冲突时追加序号
func timeImageName(dir, ext string) string {
	base := time.Now().Format("20060102-150405")
	for i := 0; ; i++ {
		name := base + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		if _, err := os.Stat(filepath.Join(dir, name)); os.IsNotExist(err) {
			return name
		}
	}
}

// saveToAssets 落盘公共逻辑：写入资源目录并生成 markdown 引用
func (a *App) saveToAssets(data []byte, ext string) (*SaveImageResult, error) {
	dir := a.resolveAssetsDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	name := timeImageName(dir, ext)
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, data, 0644); err != nil {
		return nil, err
	}

	// markdown 引用：relative 模式且当前文件已保存 → 相对路径；否则绝对路径
	var src string
	if a.settings.AssetMode == "relative" && a.curPath != "" {
		src = pathSlash(a.settings.AssetsFolder) + "/" + name
	} else {
		src = pathSlash(abs)
	}
	return &SaveImageResult{Path: abs, Src: src}, nil
}

// extFromContentType 由响应 Content-Type 推断扩展名
func extFromContentType(ct string) string {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	switch ct {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/bmp":
		return ".bmp"
	case "image/avif":
		return ".avif"
	}
	return ""
}

// extFromURL 由 URL 路径推断扩展名（白名单校验）
func extFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	ext := strings.ToLower(filepath.Ext(u.Path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			return ".jpg"
		}
		return ext
	}
	return ""
}

// SaveImage 把前端传来的图片（base64）写入本地并返回 markdown 引用路径
func (a *App) SaveImage(fileName string, base64Data string) (*SaveImageResult, error) {
	// 兼容 dataURL 前缀
	if i := strings.Index(base64Data, ","); i >= 0 && strings.HasPrefix(base64Data, "data:") {
		base64Data = base64Data[i+1:]
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return nil, fmt.Errorf("解码图片失败: %w", err)
	}

	ext := strings.ToLower(filepath.Ext(fileName))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			ext = ".jpg"
		}
	default:
		ext = ".png"
	}
	return a.saveToAssets(data, ext)
}

// DownloadImage 下载网络图片到本地资源目录并返回 markdown 引用路径
func (a *App) DownloadImage(rawURL string) (*SaveImageResult, error) {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return nil, fmt.Errorf("仅支持 http(s) 图片地址")
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return nil, fmt.Errorf("下载图片失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载图片失败: HTTP %d", resp.StatusCode)
	}
	const maxImageSize = 50 << 20 // 50MB
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageSize))
	if err != nil {
		return nil, fmt.Errorf("读取图片失败: %w", err)
	}

	ext := extFromContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		ext = extFromURL(rawURL)
	}
	if ext == "" {
		ext = ".png"
	}
	return a.saveToAssets(data, ext)
}

// pathSlash 统一成正斜杠，方便 markdown 引用与 URL 传输
func pathSlash(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// ---------- 图片查看 ----------

// ViewImage 打开独立图片查看窗口（新起一个查看器进程）
func (a *App) ViewImage(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("图片不存在: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return exec.Command(exe, "--image-viewer", abs).Start()
}

// SetWindowSize 调整主窗口尺寸并居中显示
func (a *App) SetWindowSize(width, height int) {
	if a.ctx == nil {
		return
	}
	if width < 420 {
		width = 420
	}
	if height < 320 {
		height = 320
	}
	runtime.WindowSetSize(a.ctx, width, height)
	runtime.WindowCenter(a.ctx)
}

// OpenFolder 在资源管理器中打开文件夹（文件则定位到它）
func (a *App) OpenFolder(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("路径不存在: %w", err)
	}
	if st.IsDir() {
		return exec.Command("explorer", abs).Start()
	}
	return exec.Command("explorer", "/select,"+abs).Start()
}

// RevealInExplorer 在资源管理器中定位文件（图片、文档等）
func (a *App) RevealInExplorer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("文件不存在: %w", err)
	}
	return exec.Command("explorer", "/select,"+abs).Start()
}

// ---------- 文件操作 ----------

// SaveMarkdown 保存到当前笔记路径
func (a *App) SaveMarkdown(content string) (string, error) {
	if a.curPath == "" {
		return "", fmt.Errorf("尚未打开笔记")
	}
	if err := os.WriteFile(a.curPath, []byte(content), 0644); err != nil {
		return "", err
	}
	return a.curPath, nil
}

// ClosePath 关闭笔记时清空当前路径
func (a *App) ClosePath() {
	a.curPath = ""
}
