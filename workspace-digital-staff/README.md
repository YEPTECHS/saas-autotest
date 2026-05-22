# Digital Staff — 测试工作区

## 平台信息

- **测试环境：** https://digitalstaff-test.yepai.io
- **登录页：** https://digitalstaff-test.yepai.io/#/login
- **项目类型：** Digital Staff Platform

## 环境变量配置

在项目根目录的 `.env` 文件里加入：

```
DS_BASE_URL=https://digitalstaff-test.yepai.io
DS_LOGIN_EMAIL=你的登录邮箱
DS_LOGIN_PASSWORD=你的登录密码
```

## 目录结构

```
workspace-digital-staff/
├── README.md          # 本文件 — 项目说明
├── BUGS.md            # Bug 报告（BDD 格式，发给赵括）
├── flows/             # 测试 Flow YAML 文件
│   ├── ds-login.flow.yml               # 登录 flow（基础，供其他 flow 复用）
│   ├── ds-test-home.flow.yml           # 测试主页/仪表盘
│   └── ds-test-login-validation.flow.yml  # 测试登录错误验证
└── data/              # 测试数据、BDD 用例、bug 报告
```

## 运行测试

```bash
# 先设置环境变量（.env 里加入 DS_* 变量）

# 运行登录测试
pnpm flow ds-login

# 运行主页测试
pnpm flow ds-test-home

# 运行登录验证测试
pnpm flow ds-test-login-validation
```

## 测试范围

待确认（从 Linear 任务 / 赵括 获取）

建议测试模块：
- 登录 / 登出
- 主仪表盘
- Digital Staff 管理功能
- 角色/权限
- 设置页面

## BDD Bug 报告格式

发给赵括时使用以下格式（保存在 BUGS.md）：

```
场景：[场景名称]
  假设  [前提条件]
  当    [操作]
  那么  [期望结果]
  但是  [实际结果 — bug 描述]
```

**严重程度：** 高 / 中 / 低
**发现日期：** YYYY-MM-DD
**模块：** [功能模块名]
