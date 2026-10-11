describe("Fuzzy Explorer independent provider edges", () => {
  let main, leases;
  const item = "/owned-fuzzy-provider-item.txt";
  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    const shell = require("electron").shell;
    for (const method of ["openExternal", "openPath", "showItemInFolder"])
      if (!jasmine.isSpy(shell[method])) spyOn(shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.packages, "requestService").and.resolveTo(null);
    main = (await lumine.packages.activatePackage("fuzzy-explorer")).mainModule;
    main.ensureSelectList();
    await main.selectList.update({ items: [item] });
    await main.selectList.selectItem(item);
    leases = [];
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    if (lumine.packages.isPackageLoaded("fuzzy-explorer"))
      await lumine.packages.unloadPackage("fuzzy-explorer");
    await lumine.fileWatchClient.settlePendingTeardown();
    main = leases = null;
  });

  for (const contract of [
    { name: "open-external", command: "open-external", method: "openExternal", argument: item },
    { name: "native-clip", command: "copy-file", method: "copyPaths", argument: [item] },
  ]) {
    function offer(label) {
      const api = { [contract.method]: jasmine.createSpy(label).and.resolveTo(true) };
      const lease = lumine.packages.serviceHub.provide(contract.name, "1.0.0", api);
      leases.push(lease);
      return { api, lease };
    }

    async function act() {
      await main.selectList.runAction("fuzzy-explorer:" + contract.command);
    }

    it(`keeps the newer ${contract.name} provider when the older edge withdraws`, async () => {
      const older = offer("older");
      const newer = offer("newer");
      older.lease.dispose();
      await act();
      expect(newer.api[contract.method]).toHaveBeenCalledOnceWith(contract.argument);
      expect(older.api[contract.method]).not.toHaveBeenCalled();
    });

    it(`restores the earlier ${contract.name} provider when the newer edge withdraws`, async () => {
      const older = offer("older");
      const newer = offer("newer");
      newer.lease.dispose();
      await act();
      expect(older.api[contract.method]).toHaveBeenCalledOnceWith(contract.argument);
      expect(newer.api[contract.method]).not.toHaveBeenCalled();
    });

    it(`uses the latest ${contract.name} provider for ordinary actions`, async () => {
      const older = offer("older");
      const newer = offer("newer");
      await act();
      expect(newer.api[contract.method]).toHaveBeenCalledOnceWith(contract.argument);
      expect(older.api[contract.method]).not.toHaveBeenCalled();
    });
  }
});
