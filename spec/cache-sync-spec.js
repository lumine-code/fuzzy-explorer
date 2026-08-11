describe("fuzzy-explorer cache synchronization", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    spyOn(lumine.window, "onDidReceive").and.callThrough();
    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "fuzzy-explorer:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
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
