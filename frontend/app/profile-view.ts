// Compatibility view; public Profile contracts are shared with the Node service.
function showProfile() {
  window.settingsCenter?.close(false, true);
  window.workbenchContextMenu?.close();
  window.workbenchDesign?.clear();
  layoutStorage.resetSession();
  user = null;
  state = {
    projects: [],
    tasks: [],
    activities: [],
    summaries: [],
    transactions: [],
    settings: {},
  };
  summaryDraft = null;
  billPreview = null;
  document.documentElement.style.zoom = "100%";
  document.documentElement.style.setProperty("--page-zoom-scale", "1");
  $("#side-hello").textContent = "打开你的个人工作坊";
  $("#shell-page").textContent = "创建 Profile";
  window.dispatchEvent(
    new CustomEvent("workbench:state", {
      detail: { user: null, projects: [], tasks: [] },
    }),
  );
  $("#main").classList.add("wb-redesign");
  $("#main").innerHTML =
    `<div class="login-wrap profile-start"><section class="card login-card"><div class="brand workbench-brand login-brand"><span class="brand-knot" aria-hidden="true"><img src="assets/lingxi-logo.svg" alt=""></span><span class="brand-name">灵犀工作坊</span></div><p class="login-sub">创建 Profile，保存你的工作内容与个人资料。</p><form id="profile-create-form"><label class="login-field">用户名<input id="profile-username" name="username" required maxlength="30" autocomplete="off" placeholder="给你的工作坊起个名字"></label><p class="login-note">用户名和头像可以稍后在设置中修改。</p><div class="login-error" role="alert"></div><div class="login-actions"><button type="submit" class="onboarding-action">创建 Profile</button></div></form></section></div>`;
  const form = $("#profile-create-form"),
    input = $("#profile-username"),
    button = $("[type=submit]", form),
    error = $("[role=alert]", form);
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    button.disabled = true;
    error.textContent = "";
    try {
      const result = await api(
        "POST",
        "/api/profile/create",
        { username: input.value.trim() },
        { auth: true },
      );
      user = result.user;
      window.lingxiFreshProfile = true;
      await refresh();
      render();
    } catch (err) {
      if (error.isConnected) error.textContent = err.message;
    } finally {
      pending = false;
      if (button.isConnected) button.disabled = false;
    }
  };
  input.focus();
}
function showInstanceConnection() {
  $("#main").innerHTML =
    '<div class="login-wrap profile-start"><section class="card login-card"><div class="brand workbench-brand login-brand"><span class="brand-knot"><img src="assets/lingxi-logo.svg" alt=""></span><span class="brand-name">灵犀工作坊</span></div><p class="login-sub">连接这台电脑上的工作坊。</p><form><label class="login-field">实例访问凭证<input name="token" type="password" required autocomplete="off"></label><p class="login-note">在运行工作坊的电脑上，从资料设置获取访问凭证。</p><div class="login-error" role="alert"></div><button class="onboarding-action" type="submit">连接工作坊</button></form></section></div>';
  const form = $("form", $("#main"));
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $("[type=submit]", form);
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api(
        "POST",
        "/api/instance/connect",
        { token: form.elements.token.value },
        { auth: true },
      );
      const session = await api("GET", "/api/profile/session", undefined, {
        auth: true,
      });
      user = session.user;
      if (!user) {
        showProfile();
        return;
      }
      await refresh();
      render();
    } catch (error) {
      $("[role=alert]", form).textContent = error.message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
}
