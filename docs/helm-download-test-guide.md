# Helm 下载功能测试指南

本文档提供两种下载场景的完整测试步骤，用于验证 Helm 工具集在不同智能体上的表现。

## 场景对比

| 场景 | 方式 | 适用情况 | 权限要求 |
|------|------|---------|---------|
| **A. 点击页面下载按钮** | `click` | 页面有明确的下载链接/按钮 | 无需授权（普通操作） |
| **B. 使用 download 工具** | `download` | 已知文件 URL，需精确控制保存路径 | 高危工具，需用户授权 |

---

## 场景 A：点击页面下载按钮

### 测试页面
**GitHub Releases**: https://github.com/nicehash/NiceHashQuickMiner/releases

### 操作步骤

```
1. 导航到页面
   mcp__helm__navigate(url="https://github.com/nicehash/NiceHashQuickMiner/releases")

2. 获取页面快照
   mcp__helm__get_snapshot()

3. 找到下载链接（如 "ZIP package"）
   - 查找 ref 对应的 <a> 元素，href 包含 .zip 或 .exe

4. 点击下载链接
   mcp__helm__click(ref="38")  // ref 根据实际快照调整

5. 验证下载
   - 文件自动下载到系统默认下载目录（如 C:\Users\zjc\Downloads）
   - 文件名由服务器 Content-Disposition 决定
```

### 预期结果
- ✅ 点击成功，无权限错误
- ✅ 文件出现在系统下载目录
- ✅ 文件名如 `NHQM_v0.7.8.0_RC.zip`

### 适用场景
- 页面有明确的下载按钮/链接
- 需要浏览器登录态（Cookie）
- 文件由服务端动态生成
- 不关心保存路径

---

## 场景 B：使用 download 工具

### 测试 URL
**JSONPlaceholder**: https://jsonplaceholder.typicode.com/users

### 操作步骤

```
1. 首次调用 download（触发权限检查）
   mcp__helm__download(
     url="https://jsonplaceholder.typicode.com/users",
     path="D:\codeForLearn\browser-tool\test-download\users.json"
   )

   → 返回权限错误：
   "⚠️ 工具 download 需要用户授权..."

2. 智能体询问用户授权
   使用 AskUserQuestion 询问用户：
   - 本次允许（仅当前操作）→ 调用 allow_once(tool="download")
   - 总是允许（会话级）→ 调用 set_permission(tool="download", scope="session")
   - 总是允许（项目级）→ 调用 set_permission(tool="download", scope="project")
   - 总是允许（用户级）→ 调用 set_permission(tool="download", scope="user")

3. 用户选择授权级别后，保存权限
   - 若选"本次允许"：mcp__helm__allow_once(tool="download")
   - 若选"总是允许（会话级）"：mcp__helm__set_permission(tool="download", scope="session")

4. 重新调用 download
   mcp__helm__download(
     url="https://jsonplaceholder.typicode.com/users",
     path="D:\codeForLearn\browser-tool\test-download\users.json"
   )

   → 成功下载，返回：
   {
     "ok": true,
     "url": "https://jsonplaceholder.typicode.com/users",
     "path": "D:\\codeForLearn\\browser-tool\\test-download\\users.json",
     "bytes": 5645,
     "mime": "application/json; charset=utf-8",
     "via": "gateway"
   }

5. 验证文件
   - 文件保存到指定路径
   - 内容为 JSON 格式的用户数据
```

### 预期结果
- ✅ 首次调用返回权限错误
- ✅ 智能体引导用户授权
- ✅ 授权后下载成功
- ✅ 文件保存到指定路径

### 适用场景
- 已知文件直接 URL
- 需要精确控制保存路径
- 批量下载多个文件
- 文件公开可访问（无需登录态）

---

## 权限管理工具

### 查看当前权限
```
mcp__helm__get_permissions()
```

返回示例：
```json
{
  "permissions": {
    "eval": { "session": true, "project": false, "user": false },
    "download": { "session": true, "project": false, "user": false },
    "save_file": { "session": true, "project": false, "user": false }
  },
  "projectConfigPath": "D:\\codeForLearn\\browser-tool\\.zcode\\helm-permissions.json",
  "userConfigPath": "C:\\Users\\zjc\\.zcode\\helm-permissions.json"
}
```

### 设置权限
```
mcp__helm__set_permission(tool="download", scope="session")  // 会话级
mcp__helm__set_permission(tool="download", scope="project")  // 项目级
mcp__helm__set_permission(tool="download", scope="user")     // 用户级
```

### 撤销权限
```
mcp__helm__revoke_permission(tool="download", scope="session")  // 撤销会话级
mcp__helm__revoke_permission(tool="download", scope="all")      // 撤销所有级别
```

---

## 权限配置文件

### 用户级（所有项目）
路径：`~/.zcode/helm-permissions.json`

```json
{
  "version": 1,
  "allowed": {
    "eval": true,
    "download": true,
    "save_file": true
  }
}
```

### 项目级（当前项目）
路径：`<项目>/.zcode/helm-permissions.json`

格式同上。

---

## 测试检查清单

### 场景 A（click）
- [ ] 导航到 GitHub Releases 页面
- [ ] 获取快照，找到下载链接
- [ ] 点击下载链接
- [ ] 验证文件出现在系统下载目录
- [ ] 确认无权限错误

### 场景 B（download）
- [ ] 撤销所有权限
- [ ] 调用 download 工具
- [ ] 验证返回权限错误
- [ ] 智能体询问用户授权
- [ ] 用户选择授权级别
- [ ] 调用 set_permission 保存权限
- [ ] 重新调用 download
- [ ] 验证文件保存到指定路径
- [ ] 验证文件内容正确

---

## 常见问题

### Q: 为什么 click 不需要授权，download 需要？
A: click 只是模拟用户点击页面元素，下载行为由浏览器原生处理；download 是主动发起网络请求并写入文件系统，属于高危操作。

### Q: 如何预授权所有高危工具？
A: 编辑 `~/.zcode/helm-permissions.json`，添加所有工具的授权：
```json
{
  "version": 1,
  "allowed": {
    "eval": true,
    "download": true,
    "save_file": true
  }
}
```

### Q: 会话级权限重启后会丢失吗？
A: 是的，会话级权限存储在内存中，MCP server 重启后会丢失。项目级和用户级权限持久化到文件。

### Q: 不同智能体（ZCode/Qwen CLI）的权限是共享的吗？
A: 是的，权限配置存储在文件系统中，所有使用同一 MCP server 的智能体共享权限。

---

## 更新日志

- 2026-08-08: 初始版本，包含 click 和 download 两种场景的测试步骤
