
const API_BASE = "https://framecut-subscription-api.onrender.com";

const $ = (id) => document.getElementById(id);

if ($("year")) {
  $("year").textContent = new Date().getFullYear();
}

async function api(path, body) {
  const options = {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {}
  };

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.errorMessage ||
      data.error ||
      `Request failed (${response.status})`
    );
  }

  return data;
}

function showMessage(message) {
  const element = $("message") || $("statusMessage");

  if (element) {
    element.textContent = message;
    element.hidden = false;
  } else {
    alert(message);
  }
}

// Existing authentication endpoints
async function registerAccount(email, password) {
  return api("/api/auth/register", { email, password });
}

async function loginAccount(email, password) {
  return api("/api/auth/login", { email, password });
}

async function logoutAccount() {
  return api("/api/auth/logout", {});
}

async function loadAccount() {
  return api("/api/account");
}

// Request checkout from the BACKEND.
// The server must determine the real price and plan.
async function startMonthlySubscription() {
  try {
    showMessage("Preparing secure checkout...");

    const result = await api("/api/billing/checkout", {
      plan: "monthly"
    });

    if (!result.checkoutUrl) {
      throw new Error(
        "Checkout is not configured on the server yet."
      );
    }

    // Only redirect to a valid HTTPS checkout URL.
    const checkoutUrl = new URL(result.checkoutUrl);

    if (checkoutUrl.protocol !== "https:") {
      throw new Error("The checkout URL is not secure.");
    }

    window.location.assign(checkoutUrl.href);
  } catch (error) {
    showMessage(error.message || "Unable to start checkout.");
  }
}

// Attach this to an existing button with id="subscribeMonthly",
// if that button exists in your HTML.
const subscribeButton = $("subscribeMonthly");

if (subscribeButton) {
  subscribeButton.addEventListener("click", startMonthlySubscription);
}

// Load account information when requested by your dashboard.
window.frameCutAPI = {
  registerAccount,
  loginAccount,
  logoutAccount,
  loadAccount,
  startMonthlySubscription
};
