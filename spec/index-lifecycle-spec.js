const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

describe("fuzzy-explorer index lifetime", () => {
  let main, directory, configPath, cachePath, stablePath, nextPath, crawls, broadcast;
  const flush = async () => {
    for (let index = 0; index < 40; index++) await Promise.resolve();
  };
  const configure = (patterns) => fs.writeFileSync(configPath, JSON.stringify(patterns));
  const cache = () => JSON.parse(fs.readFileSync(cachePath, "utf8"));

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    directory = fs.realpathSync.native(temp.mkdirSync("fuzzy-explorer-index-"));
    stablePath = path.join(directory, "stable.js");
    nextPath = path.join(directory, "next.js");
    fs.writeFileSync(stablePath, "stable");
    fs.writeFileSync(nextPath, "next");
    ({ mainModule: main } = await lumine.packages.activatePackage("fuzzy-explorer"));
    main.ensureSelectList();
    configPath = main.getConfigPath();
    configure([path.join(directory, "*.js")]);
    cachePath = main.getCachePath();
    broadcast = spyOn(lumine.window, "broadcast").and.resolveTo();
    main.items = [stablePath];
    main.saveCache();
    broadcast.calls.reset();
    crawls = [];
    spyOn(lumine.project, "crawl").and.callFake((options) => {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.cancel = jasmine.createSpy("cancel").and.callFake(() => resolve());
      const finish = (paths) => {
        options.didFindPaths(paths);
        resolve();
      };
      crawls.push({ options, promise, finish, reject });
      return promise;
    });
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    for (const crawl of crawls) crawl.finish([]);
    await flush();
  });

  it("discards a retired build before writing cache or publishing a broadcast", async () => {
    main.build();
    expect(crawls.length).toBe(1);
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    crawls[0].finish([nextPath]);
    await flush();
    expect(cache()).toEqual([stablePath]);
    expect(main.items).toEqual([stablePath]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("does not let an old activation overwrite a newer completed index", async () => {
    main.build();
    const old = crawls[0];
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    ({ mainModule: main } = await lumine.packages.activatePackage("fuzzy-explorer"));
    main.ensureSelectList();
    main.build();
    expect(crawls.length).toBe(2);
    if (crawls.length < 2) {
      old.finish([]);
      await flush();
      return;
    }
    crawls[1].finish([nextPath]);
    await flush();
    old.finish([stablePath]);
    await flush();
    expect(cache()).toEqual([nextPath]);
    expect(main.items).toEqual([nextPath]);
  });

  it("checks actual configuration files again before committing a build", async () => {
    main.build();
    configure([path.join(directory, "*.txt")]);
    crawls[0].finish([nextPath]);
    await flush();
    expect(cache()).toEqual([stablePath]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(main.building).toBe(false);
  });

  it("discards a build when index-affecting configuration changes", async () => {
    main.build();
    lumine.config.set("fuzzy-explorer.ignoredNames", ["next.js"]);
    crawls[0].finish([nextPath]);
    await flush();
    expect(cache()).toEqual([stablePath]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("replaces a pending refresh request and ignores its later batches", async () => {
    main.build();
    const old = crawls[0];
    main.update();
    expect(crawls.length).toBe(2);
    if (crawls.length < 2) {
      old.finish([]);
      await flush();
      return;
    }
    crawls[1].finish([nextPath]);
    await flush();
    old.finish([stablePath]);
    await flush();
    expect(cache()).toEqual([nextPath]);
    expect(main.items).toEqual([nextPath]);
  });

  it("ignores an old cache observer after a new activation", async () => {
    const subscription = spyOn(lumine.window, "onDidReceive").and.callThrough();
    main.observeCacheUpdates();
    const observer = subscription.calls.mostRecent().args[1];
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    ({ mainModule: main } = await lumine.packages.activatePackage("fuzzy-explorer"));
    main.ensureSelectList();
    const read = spyOn(main, "loadCache").and.callThrough();
    observer("old-observer-message");
    expect(read).not.toHaveBeenCalled();
  });

  it("publishes one active completed index into its actual list and cache", async () => {
    await main.selectListHost.show();
    main.build();
    crawls[0].finish([nextPath, nextPath]);
    await flush();
    expect(cache()).toEqual([nextPath]);
    expect(main.items).toEqual([nextPath]);
    expect(main.selectList.getItems()).toEqual([nextPath]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(main.building).toBe(false);
  });

  it("cancels supported crawler handles when their owner deactivates", async () => {
    main.build();
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    expect(crawls[0].promise.cancel).toHaveBeenCalledTimes(1);
    crawls[0].finish([nextPath]);
    await flush();
    expect(cache()).toEqual([stablePath]);
  });

  it("cancels an active crawl after a real observed configuration file change", async () => {
    main.build();
    await main.configWatcher.ready;
    configure([path.join(directory, "*.txt")]);
    await conditionPromise(() => crawls[0].promise.cancel.calls.count() > 0);
    crawls[0].finish([nextPath]);
    await flush();
    expect(cache()).toEqual([stablePath]);
    expect(main.building).toBe(false);
  });

  it("reports a current crawl failure and releases its remaining crawler", async () => {
    configure([path.join(directory, "*.js"), path.join(directory, "*.txt")]);
    const errors = spyOn(lumine.notifications, "addError").and.callThrough();
    main.build();
    crawls[0].reject(new Error("Current crawl failed"));
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(crawls[1].promise.cancel).toHaveBeenCalledTimes(1);
    expect(main.building).toBe(false);
    expect(cache()).toEqual([stablePath]);
  });

  it("ignores a noncooperative crawler failure after deactivation", async () => {
    const errors = spyOn(lumine.notifications, "addError");
    main.build();
    crawls[0].promise.cancel.and.stub();
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    crawls[0].reject(new Error("Old crawl failed"));
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(cache()).toEqual([stablePath]);
  });

  it("ignores a late broadcast failure from a retired owner", async () => {
    let reject;
    broadcast.and.returnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const errors = spyOn(console, "error");
    main.notifyCacheUpdate();
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    reject(new Error("Old broadcast failed"));
    await flush();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not clear a replacement build started reentrantly during publication", async () => {
    let replaced = false;
    broadcast.and.callFake(() => {
      if (!replaced) {
        replaced = true;
        expect(main.items).toEqual([nextPath]);
        main.update();
      }
      return Promise.resolve();
    });
    main.build();
    crawls[0].finish([nextPath]);
    await flush();
    expect(crawls.length).toBe(2);
    expect(main.building).toBe(true);
    crawls[1].finish([stablePath]);
    await flush();
    expect(main.items).toEqual([stablePath]);
    expect(cache()).toEqual([stablePath]);
    expect(main.building).toBe(false);
  });

  it("cancels a crawler returned after reentrant owner retirement", async () => {
    configure([path.join(directory, "*.js"), path.join(directory, "*.txt")]);
    let resolve;
    const crawl = new Promise((finish) => {
      resolve = finish;
    });
    crawl.cancel = jasmine.createSpy("cancel").and.callFake(() => resolve());
    lumine.project.crawl.and.callFake(() => {
      main.deactivate();
      return crawl;
    });
    main.build();
    await flush();
    expect(crawl.cancel).toHaveBeenCalledTimes(1);
    expect(lumine.project.crawl).toHaveBeenCalledTimes(1);
    expect(cache()).toEqual([stablePath]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
