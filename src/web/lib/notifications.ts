// Browser notifications for new mail. The browser's own permission (granted/denied/default) is
// the real gate and can only ever be loosened by the person, never by us — this only adds a
// second, softer on/off switch on top of it (localStorage) so someone who granted permission once
// can still turn the feature off without having to dig into browser settings to revoke it.
const ENABLED_KEY = "heyflare.notify.enabled";

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyPermission(): NotificationPermission | "unsupported" {
  return notifySupported() ? Notification.permission : "unsupported";
}

/** The soft switch: on by default once permission is granted, until someone turns it off here. */
export function notifyPrefEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== "0";
}

export function setNotifyPref(on: boolean) {
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
}

/** Whether a notification would actually fire right now. */
export function notifyActive(): boolean {
  return notifySupported() && Notification.permission === "granted" && notifyPrefEnabled();
}

export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return "denied";
  const p = await Notification.requestPermission();
  if (p === "granted") setNotifyPref(true);
  return p;
}

/** Skipped while the tab is actually in front of someone — they're already looking at the mail. */
export function notifyNewMail(title: string, body: string, onOpen?: () => void) {
  if (!notifyActive() || document.visibilityState === "visible") return;
  try {
    const n = new Notification(title, { body, tag: "heyflare-mail", icon: "/logo.svg" });
    n.onclick = () => {
      window.focus();
      onOpen?.();
      n.close();
    };
  } catch {
    /* some browsers throw for a background/service-worker-only Notification() outside one — safe to ignore */
  }
}
