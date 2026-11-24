(function (scope) {
  "use strict";
  const key = "cascadeMedicineBlocklist";
  const auditKey = "cascadeMedicineBlocklistAudit";
  const ordersKey = "cascadeMedicineBlocklistOrders";
  function read(store, name) {
    try { const value = JSON.parse(store.getItem(name) || "[]"); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function write(store, name, value) { store.setItem(name, JSON.stringify(value)); }
  scope.CascadeMedicineBlocklist = {
    list: () => read(scope.localStorage, key),
    has: (pip) => read(scope.localStorage, key).some((item) => item.pip === String(pip)),
    add: (product) => {
      const pip = String(product.pip || "").trim();
      if (!pip) return;
      const list = read(scope.localStorage, key).filter((item) => item.pip !== pip);
      list.push({ pip, name: String(product.name), addedAt: new Date().toISOString() });
      write(scope.localStorage, key, list);
    },
    remove: (pip) => write(scope.localStorage, key, read(scope.localStorage, key).filter((item) => item.pip !== String(pip))),
    getHistory: () => read(scope.localStorage, auditKey),
    addHistory: (entry) => write(scope.localStorage, auditKey, [...read(scope.localStorage, auditKey), entry]),
    orders: () => read(scope.sessionStorage, ordersKey),
    record: (order) => write(scope.sessionStorage, ordersKey, [order, ...read(scope.sessionStorage, ordersKey)])
  };
})(window);
