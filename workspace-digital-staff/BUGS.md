# Digital Staff — Bug 报告（BDD 格式）

> 所有测试发现的 bug 记录在这里，按 BDD 格式整理后发给赵括。

---

## 模板

```
### BUG-XXX：[标题]

- **严重程度：** 高 / 中 / 低
- **发现日期：** YYYY-MM-DD
- **模块：** [功能模块名]

场景：[描述]
  假设  [前提条件]
  当    [操作步骤]
  那么  [期望结果]
  但是  [实际结果]
```

---

## Bug 列表

### BUG-001：登录错误密码时提示信息不准确

- **严重程度：** 低
- **发现日期：** 2026-05-18
- **模块：** 登录（Login）

场景：使用错误密码登录
  假设  用户已注册账号 `kiechee.pau@yepai.io`
  当    输入正确邮箱 + 错误密码，点击 Sign in
  那么  应显示 "Invalid email or password"（邮箱或密码错误）
  但是  实际显示 "Please enter email and password"（请填写邮箱和密码）

> 错误信息应该反映真实原因（密码错误），而不是提示字段为空。

---

### BUG-002：注册时使用已存在邮箱提示信息不准确

- **严重程度：** 低
- **发现日期：** 2026-05-18
- **模块：** 注册（Register）

场景：使用已注册邮箱创建新账号
  假设  用户 `kiechee.pau@yepai.io` 已经注册
  当    在注册页填写该邮箱并点击 Create Account
  那么  应显示 "Email already registered" 或 "This email is already in use"
  但是  实际显示 "Please fill in all fields"（请填写所有字段）

> 所有字段均已填写，但系统返回了错误的提示信息，误导用户以为表单有空白项。

---

## 测试覆盖记录（2026-05-18）

| Flow | 类型 | 结果 | 备注 |
|------|------|------|------|
| ds-login | 正向 | ✅ 通过 | 正确凭据登录成功，跳转 Dashboard |
| ds-login-negative | 负向 | ✅ 通过 | 发现 BUG-001 |
| ds-register | 正向 | ✅ 通过 | 新账号注册成功，自动进入 Dashboard |
| ds-register-negative | 负向 | ✅ 通过 | 发现 BUG-002 |
| ds-test-logout | 正向 | ✅ 通过 | 登出成功，返回登录页 |
