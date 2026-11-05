package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// TreeNode 工作区目录树节点
type TreeNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	IsDir    bool       `json:"isDir"`
	Children []TreeNode `json:"children"`
}

// WorkspaceInfo 工作区信息
type WorkspaceInfo struct {
	Path string     `json:"path"`
	Name string     `json:"name"`
	Tree []TreeNode `json:"tree"`
}

// PickWorkspace 弹出目录选择框，返回工作区路径（取消时为空）
func (a *App) PickWorkspace() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择工作区目录",
	})
}

// OpenWorkspace 打开工作区：校验目录、记住到设置、返回目录树
func (a *App) OpenWorkspace(path string) (*WorkspaceInfo, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("未选择工作区")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		// ok
	} else {
		return nil, fmt.Errorf("请选择文件夹作为工作区")
	}

	a.workspace = abs
	a.curPath = ""
	a.settings.LastWorkspace = abs
	a.settings.RecentWorkspaces = pushRecentWorkspace(a.settings.RecentWorkspaces, abs)
	_ = saveSettingsToDisk(a.settings)

	return buildWorkspaceInfo(abs), nil
}

// RefreshWorkspace 重新读取当前工作区目录树
func (a *App) RefreshWorkspace() (*WorkspaceInfo, error) {
	if a.workspace == "" {
		return nil, fmt.Errorf("尚未打开工作区")
	}
	if _, err := os.Stat(a.workspace); err != nil {
		return nil, fmt.Errorf("工作区目录不存在: %w", err)
	}
	return buildWorkspaceInfo(a.workspace), nil
}

func buildWorkspaceInfo(root string) *WorkspaceInfo {
	return &WorkspaceInfo{
		Path: root,
		Name: filepath.Base(root),
		Tree: readTree(root),
	}
}

// readTree 递归读取目录：只列出子目录和 Markdown 文件，跳过隐藏项
func readTree(dir string) []TreeNode {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	nodes := make([]TreeNode, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join(dir, name)
		if e.IsDir() {
			nodes = append(nodes, TreeNode{Name: name, Path: p, IsDir: true, Children: readTree(p)})
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		if ext == ".md" || ext == ".markdown" {
			nodes = append(nodes, TreeNode{Name: name, Path: p})
		}
	}
	// 目录在前，同类按名称排序（忽略大小写）
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
	return nodes
}

// OpenNote 打开工作区内的笔记
func (a *App) OpenNote(path string) (*FileData, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if !a.inWorkspace(abs) {
		return nil, fmt.Errorf("只能打开工作区内的文件")
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	a.curPath = abs
	return &FileData{Path: abs, Content: string(data)}, nil
}

// CreateNote 在工作区目录下新建 .md 笔记，返回新文件路径
func (a *App) CreateNote(dir, name string) (string, error) {
	base, err := cleanEntryName(name)
	if err != nil {
		return "", err
	}
	if ext := strings.ToLower(filepath.Ext(base)); ext != ".md" && ext != ".markdown" {
		base += ".md"
	}
	full, err := a.resolveInWorkspace(dir, base)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(full); err == nil {
		return "", fmt.Errorf("同名文件已存在: %s", base)
	}
	if err := os.WriteFile(full, []byte(""), 0644); err != nil {
		return "", err
	}
	return full, nil
}

// CreateFolder 在工作区目录下新建文件夹
func (a *App) CreateFolder(dir, name string) (string, error) {
	base, err := cleanEntryName(name)
	if err != nil {
		return "", err
	}
	full, err := a.resolveInWorkspace(dir, base)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(full); err == nil {
		return "", fmt.Errorf("同名文件夹已存在: %s", base)
	}
	if err := os.MkdirAll(full, 0755); err != nil {
		return "", err
	}
	return full, nil
}

// RenameEntry 重命名文件或文件夹（.md 文件自动保留扩展名），返回新路径
func (a *App) RenameEntry(path, newName string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if !a.inWorkspace(abs) {
		return "", fmt.Errorf("只能重命名工作区内的条目")
	}
	base, err := cleanEntryName(newName)
	if err != nil {
		return "", err
	}

	isDir := false
	if st, statErr := os.Stat(abs); statErr == nil && st.IsDir() {
		isDir = true
	}
	if !isDir {
		oldExt := filepath.Ext(abs)
		// 用户没写扩展名时沿用原扩展名
		if filepath.Ext(base) == "" {
			base += oldExt
		}
	}
	if base == filepath.Base(abs) {
		return abs, nil
	}
	full, err := a.resolveInWorkspace(filepath.Dir(abs), base)
	if err != nil {
		return "", err
	}
	if _, statErr := os.Stat(full); statErr == nil {
		return "", fmt.Errorf("同名条目已存在: %s", base)
	}
	if err := os.Rename(abs, full); err != nil {
		return "", err
	}
	// 当前打开的笔记被重命名时同步路径
	if a.curPath == abs {
		a.curPath = full
	}
	return full, nil
}

// DeleteEntry 删除文件或文件夹（文件夹连同子项一起删除）
func (a *App) DeleteEntry(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if !a.inWorkspace(abs) || filepath.Clean(abs) == filepath.Clean(a.workspace) {
		return fmt.Errorf("不能删除工作区根目录")
	}
	st, err := os.Stat(abs)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err := os.RemoveAll(abs); err != nil {
			return err
		}
	} else if err := os.Remove(abs); err != nil {
		return err
	}
	// 打开中的笔记被删掉时清空
	if a.curPath == abs || strings.HasPrefix(a.curPath, abs+string(os.PathSeparator)) {
		a.curPath = ""
	}
	return nil
}

// cleanEntryName 校验并清理用户输入的名称
func cleanEntryName(name string) (string, error) {
	base := strings.TrimSpace(name)
	if base == "" {
		return "", fmt.Errorf("名称不能为空")
	}
	if strings.ContainsAny(base, `\/:*?"<>|`) {
		return "", fmt.Errorf(`名称不能包含 \ / : * ? " < > | 等字符`)
	}
	if strings.HasPrefix(base, ".") {
		return "", fmt.Errorf("名称不能以 . 开头")
	}
	return base, nil
}

// resolveInWorkspace 校验目标目录在工作区内，并返回拼好的绝对路径
func (a *App) resolveInWorkspace(dir, name string) (string, error) {
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if !a.inWorkspace(absDir) {
		return "", fmt.Errorf("目录不在当前工作区内")
	}
	return filepath.Join(absDir, name), nil
}

// inWorkspace 判断路径是否位于当前工作区内
func (a *App) inWorkspace(p string) bool {
	if a.workspace == "" {
		return false
	}
	root := filepath.Clean(a.workspace)
	target := filepath.Clean(p)
	if target == root {
		return true
	}
	return strings.HasPrefix(target, root+string(os.PathSeparator))
}

// pushRecentWorkspace 把工作区放到最近列表最前（最多 8 个）
func pushRecentWorkspace(list []string, path string) []string {
	out := []string{path}
	for _, p := range list {
		if !strings.EqualFold(p, path) {
			out = append(out, p)
		}
	}
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}
