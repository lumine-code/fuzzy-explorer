const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("fuzzy-explorer native file action boundaries", () => {
  let root, main, previousPaths, editors;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    const shell = require("electron").shell;
    for (const method of ["openExternal", "openPath", "showItemInFolder"])
      if (!jasmine.isSpy(shell[method])) spyOn(shell, method).and.returnValue(Promise.resolve());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-explorer-owned-actions-"));
    fs.writeFileSync(path.join(root, "source.txt"), "Owned source content");
    fs.symlinkSync(path.join(root, "source.txt"), path.join(root, "linked.txt"), "file");
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([root]);
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("fuzzy-explorer")).mainModule;
    main.ensureSelectList();
    editors = [];
  });
  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(root + path.sep)) editor.destroy();
    if (lumine.packages.isPackageActive("fuzzy-explorer"))
      await lumine.packages.deactivatePackage("fuzzy-explorer");
    if (lumine.packages.isPackageLoaded("fuzzy-explorer"))
      await lumine.packages.unloadPackage("fuzzy-explorer");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporary = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(temporary, target);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Fixture cleanup escaped the private temporary directory.");
    fs.unlinkSync(path.join(target, "linked.txt"));
    fs.unlinkSync(path.join(target, "source.txt"));
    fs.rmdirSync(target);
    main = root = null;
  });
  async function selected(file) {
    const item = file;
    await main.selectList.update({ items: [item] });
    main.selectList.selectItem(item);
    expect(main.selectList.getSelectedItem()).toBe(item);
  }
  for (const [file, command] of [
    ["linked.txt", "open"],
    ["linked.txt", "split-right"],
    ["source.txt", "open"],
  ]) {
    it("reads the actual " + file + " target through " + command, async () => {
      await selected(path.join(root, file));
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      await main.selectList.runAction("fuzzy-explorer:" + command);
      expect(open).toHaveBeenCalledTimes(1);
      if (!open.calls.count()) return;
      const editor = await open.calls.mostRecent().returnValue;
      editors.push(editor);
      expect(editor.getText()).toBe("Owned source content");
    });
  }
  it("reports a deleted indexed file and preserves its named Core editor", async () => {
    await selected(path.join(root, "source.txt"));
    fs.unlinkSync(path.join(root, "source.txt"));
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const error = spyOn(lumine.notifications, "addError").and.callThrough();
    await main.selectList.runAction("fuzzy-explorer:open");
    expect(error).toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    const editor = await open.calls.mostRecent().returnValue;
    editors.push(editor);
    expect(editor.getPath()).toBe(path.join(root, "source.txt"));
    expect(editor.getText()).toBe("");
    fs.writeFileSync(path.join(root, "source.txt"), "Owned source content");
  });
});
