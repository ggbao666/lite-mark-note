package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceOps(t *testing.T) {
	root := t.TempDir()
	app := &App{settings: DefaultSettings(), workspace: root}

	// 建目录 / 笔记
	dir, err := app.CreateFolder(root, "日记")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	note, err := app.CreateNote(root, "第一篇")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if filepath.Ext(note) != ".md" {
		t.Fatalf("笔记扩展名不对: %s", note)
	}
	if _, err := os.Stat(note); err != nil {
		t.Fatalf("笔记未创建: %v", err)
	}
	if _, err := app.CreateNote(root, "第一篇"); err == nil {
		t.Fatal("同名笔记应报错")
	}

	sub, err := app.CreateNote(dir, "子笔记")
	if err != nil {
		t.Fatalf("子目录建笔记: %v", err)
	}

	// 目录树：目录在前，只含 .md
	info := buildWorkspaceInfo(root)
	if info.Name != filepath.Base(root) || len(info.Tree) != 2 {
		t.Fatalf("目录树结构不对: %+v", info.Tree)
	}
	if !info.Tree[0].IsDir || info.Tree[0].Name != "日记" {
		t.Fatalf("目录应排在最前: %+v", info.Tree[0])
	}

	// 重命名（不带扩展名时保留 .md）
	newPath, err := app.RenameEntry(note, "改名后")
	if err != nil {
		t.Fatalf("RenameEntry: %v", err)
	}
	if filepath.Base(newPath) != "改名后.md" {
		t.Fatalf("重命名结果不对: %s", newPath)
	}
	if _, err := os.Stat(note); err == nil {
		t.Fatal("旧文件应已不存在")
	}

	// 打开笔记
	data, err := app.OpenNote(newPath)
	if err != nil {
		t.Fatalf("OpenNote: %v", err)
	}
	if data.Path != newPath {
		t.Fatalf("打开路径不一致: %s", data.Path)
	}
	if err := os.WriteFile(newPath, []byte("# 内容"), 0644); err != nil {
		t.Fatal(err)
	}
	data, _ = app.OpenNote(newPath)
	if !strings.Contains(data.Content, "内容") {
		t.Fatalf("读取内容失败: %q", data.Content)
	}

	// 删除文件夹（含子笔记）
	if err := app.DeleteEntry(dir); err != nil {
		t.Fatalf("DeleteEntry: %v", err)
	}
	if _, err := os.Stat(sub); err == nil {
		t.Fatal("子笔记应随文件夹一起删除")
	}

	// 越界保护：不能在工作区外创建
	if _, err := app.CreateNote(filepath.Dir(root), "外部"); err == nil {
		t.Fatal("工作区外创建应被拒绝")
	}
	if err := app.DeleteEntry(root); err == nil {
		t.Fatal("不应允许删除工作区根目录")
	}
}
