function dataSettings(root) {
  const body = viewHeader(
    root,
    "数据与备份",
    "备份整个 Profile，包含工作内容、个人资料、设置与凭据。",
  );
  body.innerHTML =
    '<section class="control-section"><div class="control-actions"><button class="btn" data-backup>创建加密备份</button><button class="btn ghost" data-export-profile>导出加密 Profile</button><label class="btn ghost">导入 Profile<input type="file" data-import-profile accept=".lxprofile,.json" hidden></label><a class="btn ghost" href="ui-kit.html">UI 组件库 ↗</a></div><p class="meta">请妥善保存备份口令，恢复时需要使用。</p><p class="control-form-error" role="alert"></p><div data-backup-list></div></section>';
  const identity = user.username,
    active = () => root.isConnected && user?.username === identity;
  const passwordDialog = (title, confirmPassword, submit) =>
    dialog(
      title,
      `<label class="control-field">备份口令<input type="password" name="password" required minlength="8" maxlength="1024" autocomplete="new-password"></label>${confirmPassword ? '<label class="control-field">再次输入口令<input type="password" name="confirmPassword" required minlength="8" autocomplete="new-password"></label>' : ""}<p class="meta">口令只用于本次加密或恢复，不会保存在浏览器中。</p>`,
      async (fields) => {
        if (confirmPassword && fields.password !== fields.confirmPassword)
          throw new Error("两次输入的口令不一致");
        await submit(fields.password);
      },
    );
  const reloadProfile = async () => {
    const result = await call("GET", "/api/profile/session", undefined, {
      auth: true,
    });
    if (result.user?.username !== user?.username) {
      window.settingsCenter?.close(false, true);
      layoutStorage.resetSession();
    }
    user = result.user;
    await refresh();
    render();
  };
  const downloadBackup = async (filename) => {
    const response = await fetch(
      "/api/backups/file?file=" + encodeURIComponent(filename),
    );
    if (!response.ok)
      throw new Error((await response.json()).error || "备份下载失败");
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const list = async () => {
    try {
      const result = await call("GET", "/api/backups");
      if (!active()) return;
      q("[data-backup-list]", body).innerHTML = result.backups.length
        ? result.backups
            .map(
              (row) =>
                `<div class="resource-row"><div class="resource-details"><h3>${e(new Date(row.at * 1000).toLocaleString())}</h3><small>${(row.size / 1024).toFixed(1)} KB · 完整 Profile · 已加密</small></div><div class="resource-actions"><button class="btn ghost" data-download-backup="${e(row.file)}">下载</button><button class="btn ghost" data-restore-profile="${e(row.file)}">恢复</button></div></div>`,
            )
            .join("")
        : '<div class="control-empty">尚无 Profile 备份</div>';
      qa("[data-download-backup]", body).forEach(
        (b) =>
          (b.onclick = () =>
            action(() => downloadBackup(b.dataset.downloadBackup))),
      );
      qa("[data-restore-profile]", body).forEach(
        (b) =>
          (b.onclick = () => {
            if (!confirm("恢复此 Profile 备份？当前资料会先生成加密恢复副本。"))
              return;
            passwordDialog("恢复 Profile", false, async (password) => {
              await call("POST", "/api/restore", {
                file: b.dataset.restoreProfile,
                password,
              });
              await reloadProfile();
              toast("Profile 已恢复");
            });
          }),
      );
    } catch (error) {
      if (active()) q("[role=alert]", body).textContent = error.message;
    }
  };
  q("[data-backup]", body).onclick = () =>
    passwordDialog("创建加密备份", true, async (password) => {
      await call("POST", "/api/backup", { password });
      toast("加密备份已创建");
      await list();
    });
  q("[data-export-profile]", body).onclick = () =>
    passwordDialog("导出加密 Profile", true, async (password) => {
      const result = await call("POST", "/api/backup", { password });
      await downloadBackup(result.file);
      await list();
      toast("加密 Profile 已导出");
    });
  q("[data-import-profile]", body).onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const envelope = JSON.parse(await file.text());
      if (envelope.format !== "lingxi-profile-encrypted")
        throw new Error("请选择加密的 .lxprofile 备份");
      passwordDialog("导入 Profile", false, async (password) => {
        if (
          !confirm("用这个备份恢复当前 Profile？现有资料会先生成加密恢复副本。")
        )
          return;
        await call("POST", "/api/import", { envelope, password });
        await reloadProfile();
        toast("Profile 已导入");
      });
    } catch (error) {
      q("[role=alert]", body).textContent = error.message;
    } finally {
      event.target.value = "";
      delete event.target.dataset.wbDirty;
    }
  };
  if (!window.workbenchDesktop) {
    const access = document.createElement("section");
    access.className = "control-section";
    access.innerHTML =
      '<h3>局域网访问</h3><p class="meta">重启网页后台后生效。实例凭证每次启动更新，仅在本机显示。</p><label class="control-checkbox"><input type="checkbox" data-lan-enabled>允许局域网设备访问</label><button class="btn ghost" data-lan-save>保存访问范围</button><details><summary>查看实例访问凭证</summary><input class="wb-instance-token" readonly aria-label="实例访问凭证" autocomplete="off"><button class="btn ghost" data-copy-token>复制凭证</button></details><p role="alert" class="control-form-error"></p>';
    body.append(access);
    call("GET", "/api/instance/access")
      .then((result) => {
        if (!active()) return;
        q("[data-lan-enabled]", access).checked = result.host === "0.0.0.0";
        q(".wb-instance-token", access).value = result.token;
      })
      .catch(() => access.remove());
    q("[data-lan-save]", access).onclick = async () => {
      const button = q("[data-lan-save]", access);
      button.disabled = true;
      try {
        await call("POST", "/api/instance/access", {
          enabled: q("[data-lan-enabled]", access).checked,
        });
        delete q("[data-lan-enabled]", access).dataset.wbDirty;
        toast("访问范围已保存，请正常退出并重启网页后台");
      } catch (error) {
        q("[role=alert]", access).textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    q("[data-copy-token]", access).onclick = () =>
      navigator.clipboard.writeText(q(".wb-instance-token", access).value).then(
        () => toast("实例凭证已复制"),
        () => toast("请选中凭证手动复制"),
      );
  }
  list();
  window.profileManagement?.mount(body);
  const restart = document.createElement("button");
  restart.className = "btn ghost onboarding-start-again";
  restart.textContent = "重新打开启动引导";
  restart.onclick = () =>
    window.lingxiOnboarding?.open().catch((error) => toast(error.message));
  body.append(restart);
}
