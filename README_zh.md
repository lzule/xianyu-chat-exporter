# 闲鱼聊天记录导出插件

Chrome 扩展，用于将 **闲鱼聊天记录**（`xianyu.com` / `goofish.com`）导出为 JSON。

## 维护日志

### 2026-04-27

- 修复商品图片检测：优先定位聊天顶部商品区 DOM（`main [class*="left--"] img`），再回退到 CDN 模式搜索
- 新增交易状态检测：读取侧边栏会话列表的 `order-success` 标签，写入 JSON 和 HTML 导出
- 商品名称和图片检测更稳定，使用精确 DOM 选择器

### 2026-04-26

- 重构导出流程：注入函数返回数据给 popup 下载，不再依赖 `chrome.runtime.sendMessage`，消除因 background service worker 冷启动导致的"未知错误"崩溃
- 新增 `background.js` service worker 处理下载和 badge 通知
- 移除 Markdown 导出，仅保留 JSON
- 修复 `sanitizeName` 二进制控制字符导致的 `chrome.scripting.executeScript` 序列化失败
- 文件名改用导出时刻（`YYYY-MM-DD_HH-mm`），不再依赖消息时间戳
- 加速自动滚动：等待间隔 `650ms → 300ms`，停滞轮数 `4 → 2`
- 移除捐赠图片，清理 `.gitignore`

### 2026-04-25

- Fork 并开始自定义
- 添加滚动链路诊断和路由驱动的自动滚动
- 改进自动滚动容器检测和批量滚动稳定性

## 导出格式

### 文件命名

`对方昵称_YYYY-MM-DD_HH-mm.json`

- 时间戳为导出时刻，精确到分钟。
- 昵称经过文件名安全处理。

### JSON 结构

```json
{
  "product": "商品图片URL 或 未识别商品",
  "messages": [
    { "id": 0, "role": "me", "text": "消息内容" },
    { "id": 1, "role": "other", "text": "消息内容" }
  ]
}
```

- `product`：商品图片 URL，未找到时为 `未识别商品`
- `role`：`me`（我方发送）或 `other`（对方发送）
- 头像/占位图 URL 会自动过滤

## 功能说明

- 支持导出前自动翻取聊天记录到顶部（可关闭），并显示运行进度
- 支持批量导出左侧全部会话
- 批量导出过程实时显示：当前序号、成功/失败/跳过计数、文件数、预计剩余时间
- 导出结束输出可核对报告：文件计数校验、失败清单
- 支持设置默认导出子文件夹（保存到浏览器下载目录下）

## 安装方法

1. 打开 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择目录 `xianyu-chat-exporter`
