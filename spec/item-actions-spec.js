describe("fuzzy-explorer item actions", () => {
  let main;
  const selectedPath = __filename;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // The package activates on its commands, so dispatch one to trigger it;
    // activation also loads the package keymap the actions list reads.
    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "fuzzy-explorer:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });

  it("describes its explicit actions with command metadata and keybindings", async () => {
    await main.selectList.update({ items: [selectedPath] });
    const actions = main.selectList.getAvailableActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const openExternal = byCommand.get("fuzzy-explorer:open-external");
    expect(openExternal.name).toBe("Open External");
    expect(openExternal.description).toBe("Open the file in the default external program.");
    expect(openExternal.keystrokes).toEqual(["alt-f12"]);

    // `alt-v` is a chord prefix and nothing else. Binding it as a complete
    // keystroke too made every press sit out the 1000 ms partial-match timeout
    // before the default variant fired.
    const insertRelative = byCommand.get("fuzzy-explorer:insert-relative-path");
    expect([...insertRelative.keystrokes].sort()).toEqual(["alt-v alt-r"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }
    expect(byCommand.get("fuzzy-explorer:copy-absolute-path").description).toBe(
      "Copy the full path from the filesystem root to the clipboard.",
    );
    expect(byCommand.get("fuzzy-explorer:open").keystrokes).toEqual(["enter"]);
    expect(byCommand.get("fuzzy-explorer:edit").group).toBe("Explorer");

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("fuzzy-explorer:toggle")).toBe(false);
  });

  it("offers the core recent-history actions only while that history exists", async () => {
    main.selectList.selectNone();

    expect(
      main.selectList
        .getAvailableActions()
        .some(({ command }) => command === "select-list:clear-recents"),
    ).toBe(false);

    await main.selectList.setRecentItemIds([selectedPath]);
    const clear = main.selectList
      .getAvailableActions()
      .find(({ command }) => command === "select-list:clear-recents");
    expect(clear.context).toBe("dialog");
  });

  it("uses the action disposition to hide before opening its configuration", async () => {
    const fs = require("fs");
    spyOn(fs, "existsSync").and.returnValue(true);
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    await main.selectList.show();

    await main.selectList.runAction("fuzzy-explorer:edit");

    expect(main.selectList.isVisible()).toBe(false);
    expect(lumine.workspace.open).toHaveBeenCalled();
  });

  it("shows the shared action palette as a flow step and runs against the master list", async () => {
    await main.selectList.show();

    expect(await main.selectList.showActions()).toBe(true);

    expect(lumine.workspace.getModalTrail()).toEqual(["Explorer", "Actions"]);
    lumine.workspace.popModal();

    const spy = spyOn(main, "update");
    await main.selectList.runAction("fuzzy-explorer:refresh-index");

    expect(spy).toHaveBeenCalled();
    expect(main.selectList.isVisible()).toBeTruthy();
  });
});
