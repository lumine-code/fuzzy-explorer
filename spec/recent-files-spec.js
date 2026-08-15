describe("fuzzy-explorer recent files", () => {
  let main, workspaceElement;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    lumine.config.set("fuzzy-explorer.recentCount", 10);

    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
    main.clearRecent();

    // The index is built from the user's own glob config, so the specs seed it
    // directly rather than crawling a fixture tree.
    main.items = ["/tmp/alpha.txt", "/tmp/beta.txt", "/tmp/gamma.txt"];
    main.pending = true;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });

  async function showList() {
    main.selectList.show();
    await lumine.views.getNextUpdatePromise();
    return main.selectList;
  }

  it("keeps the files it opened at the top, ruled off from the rest", async () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.recordRecent("/tmp/beta.txt");

    const selectList = await showList();

    expect(selectList.items[0]).toBe("/tmp/beta.txt");
    const separator = selectList.element.querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");
  });

  it("stands the section down under a query", async () => {
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();

    selectList.refs.queryEditor.setText("alpha");
    await lumine.views.getNextUpdatePromise();

    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("records a file when it is opened, most recent first", () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    spyOn(main.selectList, "getSelectedItem").and.returnValue("/tmp/alpha.txt");
    // performAction stats the path before opening it; a miss is reported and
    // the open still runs, which is the path under test here.
    main.performAction("open");

    expect(main.recentlyUsed[0]).toBe("/tmp/alpha.txt");
    expect(main.serialize()).toEqual({ recentlyUsed: main.recentlyUsed });
  });

  it("caps the list at the configured count", () => {
    lumine.config.set("fuzzy-explorer.recentCount", 2);
    main.recordRecent("/tmp/alpha.txt");
    main.recordRecent("/tmp/beta.txt");
    main.recordRecent("/tmp/gamma.txt");

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt", "/tmp/beta.txt"]);
  });

  it("forgets everything on clear-recent", async () => {
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();

    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:clear-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("restores what it serialized", async () => {
    main.recordRecent("/tmp/beta.txt");
    expect(main.serialize()).toEqual({ recentlyUsed: ["/tmp/beta.txt"] });

    // Deactivation stores what serialize() returned, and the package activates
    // on its commands, so the round trip needs one dispatched to complete.
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    const pack = await activation;
    pack.mainModule.selectList.hide();

    expect(pack.mainModule.recentlyUsed).toEqual(["/tmp/beta.txt"]);
  });
});
