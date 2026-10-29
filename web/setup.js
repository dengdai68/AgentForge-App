const form = document.querySelector("#setup-form"), password = document.querySelector("#password"), confirmation = document.querySelector("#confirmation"), error = document.querySelector("#setup-error"), submit = form.querySelector(".submit");
document.querySelector("#toggle-password").addEventListener("click", event => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  confirmation.type = show ? "text" : "password";
  event.currentTarget.textContent = show ? "隐藏" : "显示";
  event.currentTarget.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  event.currentTarget.setAttribute("aria-pressed", String(show));
});
form.addEventListener("submit", async event => {
  event.preventDefault(); if (submit.disabled) return;
  error.textContent = "";
  if (password.value !== confirmation.value) { error.textContent = "两次输入的密码不一致。"; confirmation.focus(); return; }
  submit.disabled = true; submit.textContent = "正在创建…";
  try {
    const response = await fetch("/api/auth/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.username.value.trim(), password: password.value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "创建管理员失败，请重试");
    location.replace("/");
  } catch (failure) { error.textContent = failure.message || "网络连接失败，请重试"; password.value = ""; confirmation.value = ""; password.focus(); }
  finally { submit.disabled = false; submit.textContent = "创建管理员并进入工作区"; }
});
