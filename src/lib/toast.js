let _show = null;

export function registerToast(fn) {
  _show = fn;
}

export function showToast(message, type = 'info') {
  _show?.(message, type);
}
