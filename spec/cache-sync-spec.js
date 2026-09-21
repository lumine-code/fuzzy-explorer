describe("fuzzy-explorer cache synchronization", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    spyOn(lumine.window, "onDidReceive").and.callThrough();
    await lumine.packages.startPackage("fuzzy-explorer");
    await lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "fuzzy-explorer:toggle");
    main = lumine.packages.getLoadedPackage("fuzzy-explorer").mainModule;
    main.selectListHost.hide();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });

  it("subscribes through the public window service", () => {
    const [eventName, callback] = lumine.window.onDidReceive.calls.mostRecent().args;
    expect(eventName).toBe("fuzzy-explorer:cache-updated");
    expect(typeof callback).toBe("function");
  });

  it("broadcasts cache changes through the public window service", () => {
    spyOn(lumine.window, "broadcast").and.resolveTo();
    main.cacheFingerprint = "fingerprint";

    main.notifyCacheUpdate();

    expect(lumine.window.broadcast).toHaveBeenCalledWith(
      "fuzzy-explorer:cache-updated",
      "fingerprint",
    );
  });
});
