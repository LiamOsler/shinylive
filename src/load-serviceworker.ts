import { dirname, currentScriptDir } from "./utils";

const localhostNames = ["localhost", "127.0.0.1", "[::1]"];

if (
  window.location.protocol !== "https:" &&
  !localhostNames.includes(window.location.hostname)
) {
  const errorMessage =
    "Shinylive uses a Service Worker, which requires either a connection to localhost, or a connection via https.";
  document.body.innerText = errorMessage;
  throw Error(errorMessage);
}

const serviceWorkerPath = dirname(currentScriptDir()) + "/serviceworker.js";

// Start the service worker as soon as possible, to maximize the
// resources it will be able to cache on the first run.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register(serviceWorkerPath)
    .then(() => console.log("Service Worker registered"))
    .catch(() => console.log("Service Worker registration failed"));

  navigator.serviceWorker.ready.then(() => {
    if (!navigator.serviceWorker.controller) {
      // For Shift+Reload case; navigator.serviceWorker.controller will
      // never appear until a regular (not Shift+Reload) page load.
      window.location.reload();
    }
  });
}
