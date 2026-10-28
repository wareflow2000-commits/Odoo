export const OW = {
  pages: {},
  modals: {},
  currentPage: null,
  registerPage(name, def) { this.pages[name] = def; },
  registerModal(id, def) { this.modals[id] = def; }
};
window.OW = OW;