# PDA 护患对话 AI 填表演示

这是一个可部署的最小演示包，包含：

- 医院 PDA 风格的高保真原型页面
- 腾讯云实时语音识别 WebSocket 后端适配
- 语音转写、结构化字段提取、右侧表单同步展示
- 部署到 Render 的配置文件

## 本地启动

```bash
npm install
npm start
```

默认地址：

```text
http://127.0.0.1:8788/high-fidelity-prototype.html
```

## 环境变量

复制 `.env.example` 中的变量到部署平台的 Environment Variables。

必须配置：

- `TENCENT_APP_ID`
- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`

不要把真实密钥提交到 Git。

## Render 部署

1. 把本目录上传到 GitHub。
2. 在 Render 创建 Web Service。
3. 选择该 GitHub 仓库。
4. Build Command 使用 `npm install`。
5. Start Command 使用 `npm start`。
6. 设置环境变量。
7. 部署完成后访问 Render 给出的公网 URL。

