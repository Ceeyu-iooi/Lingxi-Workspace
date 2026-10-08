// Compatibility view; public Profile contracts are shared with the Node service.
function showProfile() {
  window.settingsCenter?.close(false, true);
  window.workbenchContextMenu?.close();
  user = null;
  state = { projects: [], tasks: [], activities: [], summaries: [], transactions: [], settings: {} };
  document.documentElement.style.removeProperty("zoom");
  document.documentElement.style.setProperty("--ui-scale", "1");
  $("#main").innerHTML = '<div class="login-wrap profile-start"><section class="login-card"><div class="onboarding-brand"><img src="assets/lingxi-logo.svg" alt="灵犀"><span>灵犀工作坊</span></div><h1 class="onboarding-heading">建立你的个人资料</h1><p class="onboarding-subtitle">资料保存在所选 Profile，用户名与头像可随时修改。</p><div data-profile-editor></div></section></div>';
  window.LingxiDesign.identity($("[data-profile-editor]"), { create: true, save: async (name, avatar) => {
    if (!user) {
      const result = await api("POST", "/api/profile/create", { username: name }, { auth: true }); user = result.user;
    } else await api("POST", "/api/profile", { displayName: name });
    if (avatar) await api("POST", "/api/profile/avatar", { data: avatar });
    window.lingxiFreshProfile = true;
    await api("POST", "/api/control/config", { onboardingStep: "agents" });
    await refresh(); render();
  }});
  $("#profile-username")?.focus();
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
