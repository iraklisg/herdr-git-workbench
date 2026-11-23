// Changes for several git repos at once, as a tree per repo, with staging.
// Derived from the "changes" mod shipped with Herdr (Apache-2.0); modified.
// The repo list for a project is kept in Herdr's shared state ("git-workbench.projects"), keyed by the project root.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, pickFolder, checking, shared, setShared } from "herdr";

const ICON = (name) => "mods/git-workbench/icons/" + name + ".svg";
const ROW = 26, REPO_ROW = 30, LIMIT = 1000, GROUP_INDENT = 8;
// The last terminal folder seen in each space. When a mod pane (this one, or any other)
// has the focus, it has no folder, so the panel keeps showing the project of that terminal.
// Kept at module level on purpose: every copy of the mod shares it.
const lastFolder = new Map();
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  if (pane && pane.terminal === null) {
    // Nothing seen yet in this space: its folder.
    return (space && lastFolder.get(space.id)) || { cwd: space?.folder, on };
  }
  const here = { cwd: pane?.cwd || f?.cwd || space?.folder, on };
  if (space && (pane?.cwd || f?.cwd)) lastFolder.set(space.id, here);
  return here;
}
const locationKey = () => JSON.stringify(location());

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Rows of a unified diff, and of git's combined diff for a conflicted file: "@@@" hunks with
// one marker column per parent. Lines without "-" in their markers get the new line number.
function diffRows(lines) {
  let old = 0, next = 0, width = 1;
  return lines.map((line) => {
    const hunk = /^(@{2,}) (?:-\d+(?:,\d+)? )+\+(\d+)/.exec(line);
    if (hunk) {
      width = hunk[1].length - 1; next = +hunk[2];
      old = width === 1 ? +/^@@ -(\d+)/.exec(line)[1] : 0;
      return { kind: "@", text: line };
    }
    const marks = line.slice(0, width);
    if (marks.length < width || !/^[ +-]+$/.test(marks)) return { kind: "", text: line };
    const text = untab(line.slice(width)) || " ";
    if (marks.includes("-")) return { kind: "-", number: width === 1 ? old++ : undefined, text };
    if (width === 1) old++;
    return { kind: marks.includes("+") ? "+" : " ", number: next++, text };
  });
}

// Paths
function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}
function relative(from, to) {
  const a = from.split("/").filter(Boolean), b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
const inside = (path, root) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
const basename = (path) => path.split("/").filter(Boolean).pop() ?? path;

// Storage: { "<machine:>/abs/root": ["relative/repo", "../other"] }.
// Herdr's shared state, not localStorage: localStorage is per mod copy, and Herdr runs several copies.
const STORE = "git-workbench.projects";
function loadProjects() {
  const value = shared(STORE);
  return value && typeof value === "object" ? value : {};
}
function saveProjects(projects) { setShared(STORE, { ...projects }); }
const projectKey = (root, on) => (on ? on + ":" : "") + root;

// "add\tdel\tpath\0", or for a rename or copy "add\tdel\t\0old\0new\0". Keyed by the new path.
function parseNumstat(text, into) {
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const [a, d, ...rest] = parts[i].split("\t");
    if (!rest.length) continue;
    let path = rest.join("\t");
    if (path === "") { path = parts[i + 2]; i += 2; }
    if (path) into[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
}

// A file's paths for an action: a rename moves both its old and its new path.
const withOld = (files) => files.flatMap(f => f.old ? [f.old, f.path] : [f.path]);

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  return root;
}
function filesUnder(node, out = []) {
  out.push(...node.files);
  for (const child of node.dirs.values()) filesUnder(child, out);
  return out;
}

export default class GitWorkbench extends View {
  init(_props, cx) {
    this.repos = []; this.rows = []; this.diffWidth = 0;
    this.collapsed = new Set();
    this.open = null; this.selected = null; this.editing = false;
    this.listScroll = ScrollHandle.new();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // Which project the focused folder belongs to: the longest saved root that contains it, else its own repo.
  async resolve(cwd, on) {
    const projects = loadProjects();
    let best = null;
    for (const key of Object.keys(projects)) {
      const prefix = on ? on + ":" : "";
      if (on ? !key.startsWith(prefix) : !key.startsWith("/")) continue;
      const root = key.slice(prefix.length);
      if (inside(cwd, root) && (!best || root.length > best.length)) best = root;
    }
    if (best) return { root: best, extra: projects[projectKey(best, on)] ?? [] };
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (top.code !== 0) return null;
    return { root: top.stdout.trim(), extra: [] };
  }

  // Folder watches work on this computer only; remote projects rely on the 10-second timer.
  // After a failed watch (Herdr allows 64), the set is tried again a minute later.
  watch(paths, cx) {
    const signature = (this.on ?? "") + "\n" + paths.join("\n"), current = this.watching;
    if (!this.on && current?.signature === signature && (!current.failedAt || Date.now() - current.failedAt < 60000)) return;
    this.stopWatching();
    if (this.on) return;
    const token = { signature, handles: [], failedAt: 0 };
    this.watching = token;
    for (const path of paths) cx.spawn(async (cx) => {
      try {
        while (this.watching === token) {
          const w = watchFolder(path); token.handles.push(w);
          await w;
          token.handles = token.handles.filter(h => h !== w);
          if (this.watching === token) this.refresh(cx);
        }
      } catch { token.failedAt = Date.now(); /* the 10-second timer still refreshes */ }
    });
  }

  stopWatching() {
    for (const w of this.watching?.handles ?? []) w.cancel?.();
    this.watching = null;
  }

  refresh(cx) {
    if (this.busy) return;
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location();
    this.locKey = locationKey();
    if (!cwd) { this.stopWatching(); this.repos = []; this.root = null; this.error = null; cx.notify(); return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      const asked = this.locKey;
      try {
        const project = await this.resolve(cwd, on);
        if (asked !== locationKey()) return;
        if (!project) { this.stopWatching(); this.root = null; this.repos = []; this.error = "Not a git repository: " + (cwd || "no folder"); this.setOpen(null); return; }
        if (project.root !== this.root || on !== this.on) {
          this.collapsed = new Set(); this.setOpen(null); this.selected = null; this.editing = false; this.note = null; this.pending = null;
        }
        this.root = project.root; this.on = on;
        const rels = ["", ...project.extra.filter(r => r !== "")];
        const paths = rels.map(rel => rel ? normalize(this.root + "/" + rel) : this.root);
        const repos = await Promise.all(paths.map((path, i) => this.readRepo(path, rels[i], paths)));
        if (asked !== locationKey()) return;
        this.repos = repos; this.error = null;
        this.watch(paths.filter(p => !paths.some(o => o !== p && inside(p, o))), cx);
        // After a stage or unstage, the open file follows to its other group; when it is gone, the list shows again.
        const find = (sel) => this.repos.find(r => r.path === sel.repo)?.[sel.group].some(f => f.path === sel.path);
        if (this.open && !find(this.open)) {
          const other = { ...this.open, group: this.open.group === "staged" ? "changes" : "staged" };
          if (find(other)) { this.open = other; this.selected = other; } else this.setOpen(null);
        }
        if (this.open) {
          try { await this.load(this.open, asked); }
          catch { if (asked === locationKey()) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (asked === locationKey()) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again || asked !== locationKey()) this.refresh(cx);
      }
    });
  }

  async readRepo(path, rel, all) {
    const on = this.on;
    // The name is the repo's folder; the hint is where it is, each parent folder by its first letter
    // (p/w for packages/web), ".." kept. The project root has no hint.
    const name = basename(path), hint = rel.split("/").slice(0, -1).map(p => p === ".." ? p : [...p][0]).join("/");
    const repo = { path, rel, name, hint, branch: "", staged: [], changes: [], error: null, hasHead: true, limited: false, ahead: null, behind: null, upstream: null };
    try {
      const git = (args) => exec("git", [...READ, ...args], { cwd: path, on });
      const [status, head, branch, cached, worktree, sync, upstream] = await Promise.all([
        git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(["rev-parse", "--verify", "-q", "HEAD"]),
        git(["branch", "--show-current"]),
        git(["diff", "--cached", "--numstat", "-z"]),
        git(["diff", "--numstat", "-z"]),
        // Commits behind and ahead of the upstream branch, as of the last fetch. Fails without an upstream.
        git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
        git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      ]);
      if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
      repo.hasHead = head.code === 0;
      repo.branch = branch.stdout.trim() || "detached";
      if (sync.code === 0) { const [behind, ahead] = sync.stdout.trim().split(/\s+/).map(Number); repo.behind = behind; repo.ahead = ahead; }
      if (upstream.code === 0) repo.upstream = upstream.stdout.trim();
      const stagedStats = {}, worktreeStats = {};
      if (cached.code === 0) parseNumstat(cached.stdout, stagedStats);
      if (worktree.code === 0) parseNumstat(worktree.stdout, worktreeStats);
      // Other selected repos inside this one show as untracked folders here: they have their own section.
      const nested = all.filter(p => p !== path && inside(p, path)).map(p => relative(path, p));
      // Renames and copies (git's own detection, as VS Code shows them) are "XY new\0old\0": the old path follows.
      const parts = status.stdout.split("\0").filter(Boolean), entries = [];
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i], xy = entry.slice(0, 2), old = /[RC]/.test(xy) ? parts[++i] : undefined;
        entries.push({ xy, file: entry.slice(3), old });
      }
      repo.limited = entries.length > LIMIT;
      for (const { xy, file, old } of entries.slice(0, LIMIT)) {
        const clean = file.replace(/\/$/, "");
        if (nested.some(n => clean === n || clean.startsWith(n + "/"))) continue;
        // An untracked folder here is a nested repo that is not in the list (git does not look inside it).
        if (xy === "??") { repo.changes.push({ path: clean, mark: "U", untracked: true, nestedRepo: file.endsWith("/"), add: 0, del: 0 }); continue; }
        if (xy === "!!") continue;
        if (xy.includes("U") || xy === "AA" || xy === "DD") { repo.changes.push({ path: file, mark: "!", conflict: true, add: 0, del: 0 }); continue; }
        const [x, y] = xy, mark = (c) => c === "A" || c === "D" || c === "R" || c === "C" ? c : "M";
        // The old path goes with the side that renamed: the index (x), or an intent-to-add rename (y).
        if (x !== " ") repo.staged.push({ path: file, mark: mark(x), ...(/[RC]/.test(x) ? { old } : {}), ...(stagedStats[file] ?? { add: 0, del: 0 }) });
        if (y !== " ") repo.changes.push({ path: file, mark: mark(y), ...(/[RC]/.test(y) ? { old } : {}), ...(worktreeStats[file] ?? { add: 0, del: 0 }) });
      }
    } catch (e) { repo.error = String(e?.message ?? e); }
    return repo;
  }

  async load(sel, context) {
    const repo = this.repos.find(r => r.path === sel.repo), file = repo?.[sel.group].find(f => f.path === sel.path);
    if (!file) return;
    let lines;
    if (file.nestedRepo) lines = ["Nested git repository · add it with the repositories button to see its changes"];
    else if (file.untracked) {
      const text = await readTextFile(repo.path + "/" + file.path, { on: this.on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        const count = countLines(text);
        lines = ["@@ -0,0 +1," + count + " @@", ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => "+" + l)];
      }
    } else {
      // A rename shows as one diff of its changed lines: both paths, with rename detection on.
      const args = ["--literal-pathspecs", ...READ, "diff", ...(sel.group === "staged" ? ["--cached"] : []), ...(file.old ? ["-M"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", ...(file.old ? [file.old] : []), file.path];
      const r = await exec("git", args, { cwd: repo.path, on: this.on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : file.old ? (file.mark === "C" ? "Copied from " : "Renamed from ") + file.old + " · no content changes" : "No text diff available"] : all.slice(first);
    }
    if (context === locationKey() && this.isOpen(sel)) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  isSame(a, b) { return Boolean(a && b && a.repo === b.repo && a.group === b.group && a.path === b.path); }
  isOpen(sel) { return this.isSame(this.open, sel); }

  setOpen(sel) { this.open = sel; this.setLines([]); }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(sel, cx) {
    this.setOpen(sel); this.selected = sel; this.note = null; this.pending = null;
    const context = this.locKey;
    cx.spawn(async (cx) => {
      try { await this.load(sel, context); }
      catch (e) { if (context === locationKey() && this.isOpen(sel)) this.note = "Cannot preview this diff (too large or unreadable): " + e; }
      cx.notify();
    });
    cx.notify();
  }

  // Back to the list, at the same scroll position, with the file still selected.
  back(cx) { this.setOpen(null); this.pending = null; cx.notify(); }

  toggle(key, cx) { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); cx.notify(); }

  // Runs git commands that change a repo, one action at a time.
  act(repo, steps, cx) {
    if (this.busy) return;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          if (!args) continue;
          const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: repo.path, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { this.note = repo.name + ": " + String(e?.message ?? e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // git pull with the repo's own settings (merge or rebase). No prompts: there is no terminal to answer them.
  pull(repo, cx) {
    if (this.busy) return;
    this.busy = true; this.pulling = repo.path; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes", "git", "pull"], { cwd: repo.path, on: this.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { this.note = repo.name + ": " + String(e?.message ?? e); }
      finally { this.busy = false; this.pulling = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(repo, files, cx) {
    if (files.length) this.act(repo, [["add", "-A", "--", ...withOld(files)]], cx);
  }

  // Discard asks first: it cannot be undone. Conflicts and nested repos are left out.
  askDiscard(repo, files, label, cx) {
    files = files.filter(f => !f.conflict && !f.nestedRepo && !f.old);
    if (files.length) this.pending = { repo, files, label };
    cx.notify();
  }

  // Tracked files go back to their staged (or committed) state; untracked files are deleted.
  discard(cx) {
    const { repo, files } = this.pending ?? {};
    this.pending = null;
    if (!files?.length) return cx.notify();
    const tracked = files.filter(f => !f.untracked).map(f => f.path), untracked = files.filter(f => f.untracked).map(f => f.path);
    this.act(repo, [tracked.length ? ["restore", "--worktree", "--", ...tracked] : null, untracked.length ? ["clean", "-f", "-q", "--", ...untracked] : null], cx);
  }

  unstage(repo, files, cx) {
    if (!files.length) return;
    const paths = withOld(files);
    this.act(repo, [repo.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-f", "-q", "-r", "--", ...paths]], cx);
  }

  // Repo list editing
  editRepos(cx) {
    this.editing = !this.editing;
    cx.notify();
  }

  async toplevel(path) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, on: this.on }).catch(() => null);
    return r?.code === 0 ? r.stdout.trim() : null;
  }

  addRepos(paths) {
    const projects = loadProjects(), key = projectKey(this.root, this.on);
    const list = new Set(projects[key] ?? []);
    let added = 0;
    for (const p of paths) {
      if (!p || p === this.root) continue;
      const rel = relative(this.root, p);
      if (!list.has(rel)) { list.add(rel); added++; }
    }
    projects[key] = [...list].sort();
    saveProjects(projects);
    return added;
  }

  removeRepo(rel, cx) {
    const projects = loadProjects(), key = projectKey(this.root, this.on);
    const list = (projects[key] ?? []).filter(r => r !== rel);
    if (list.length) projects[key] = list; else delete projects[key];
    saveProjects(projects);
    this.refresh(cx); cx.notify();
  }

  addFolder(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choose a git repository" });
      if (!folder) return;
      const top = await this.toplevel(folder);
      if (!top) this.note = folder + " is not in a git repository";
      else { const added = this.addRepos([top]); this.note = added ? null : basename(top) + " is already in the list"; }
      this.refresh(cx); cx.notify();
    });
  }

  // Rendering
  iconButton(id, icon, t, onClick) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(ICON(icon)).size(14).text_color(t.muted));
  }

  hoverable(el, id) {
    return el.on_hover((hovered, cx) => {
      if (hovered) this.hovered = id; else if (this.hovered === id) this.hovered = null;
      cx.notify();
    });
  }

  actions(repo, group, files, id, label, t) {
    if (this.hovered !== id || this.busy) return [];
    if (group === "staged") return [this.iconButton(id + "-unstage", "minus", t, (cx) => this.unstage(repo, files, cx))];
    return [
      ...(files.some(f => !f.conflict && !f.nestedRepo && !f.old) ? [this.iconButton(id + "-discard", "undo-2", t, (cx) => this.askDiscard(repo, files, label, cx))] : []),
      this.iconButton(id + "-stage", "plus", t, (cx) => this.stage(repo, files.filter(f => !f.conflict), cx)),
    ];
  }

  markColor(mark, t) {
    return mark === "A" || mark === "U" || mark === "R" || mark === "C" ? t.ansi2 : mark === "D" || mark === "!" ? t.ansi1 : t.blocked;
  }

  // A row inside a group, indented under its repo.
  groupLine(id, depth, t) {
    return h_flex().id(id).h(ROW).flex_none().pr(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .child(div().w(GROUP_INDENT + depth * 14).flex_none());
  }

  treeRows(repo, group, node, prefix, depth, out, t) {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (let [name, child] of dirs) {
      // Compact folders: a folder holding only one folder shows as a/b/c.
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [nextName, next] = [...child.dirs.entries()][0];
        name += "/" + nextName; child = next;
      }
      const path = prefix ? prefix + "/" + name : name, key = "d:" + repo.path + ":" + group + ":" + path, open = !this.collapsed.has(key);
      const id = "row-" + key, files = filesUnder(child);
      out.push({ h: ROW, el: this.hoverable(this.groupLine(id, depth, t).gap(6).on_click((_e, cx) => this.toggle(key, cx))
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
        .child(svg(ICON("folder")).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name))
        .children(this.actions(repo, group, files, id, path + "/", t)), id) });
      if (open) this.treeRows(repo, group, child, path, depth + 1, out, t);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const sel = { repo: repo.path, group, path: f.path }, id = "row-f:" + repo.path + ":" + group + ":" + f.path;
      out.push({ h: ROW, el: this.hoverable(this.groupLine(id, depth, t).gap(6).when(this.isSame(this.selected, sel), (e) => e.bg(t.selected)).on_click((_e, cx) => this.pick(sel, cx))
        .child(div().w(12).flex_none())
        .child(div().id("name-" + id).flex_1().min_w(0).truncate().when(f.mark === "D", (e) => e.text_color(t.dim)).child(basename(f.path) + (f.nestedRepo ? "/" : ""))
          .when(Boolean(f.old), (e) => e.tooltip((f.mark === "C" ? "Copied from " : "Renamed from ") + f.old)))
        .children(this.actions(repo, group, [f], id, basename(f.path), t))
        .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child("+" + f.add)))
        .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child("−" + f.del)))
        .child(div().w(12).flex_none().text_size(11).text_color(this.markColor(f.mark, t)).child(f.mark)), id) });
    }
  }

  groupRows(repo, group, title, files, out, t) {
    if (!files.length) return;
    const key = "g:" + repo.path + ":" + group, open = !this.collapsed.has(key), id = "row-" + key;
    out.push({ h: ROW, el: this.hoverable(this.groupLine(id, 0, t).gap(6).on_click((_e, cx) => this.toggle(key, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title))
      .children(this.actions(repo, group, files, id, title.toLowerCase() + " files in " + repo.name, t))
      .child(div().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(files.length))), id) });
    if (open) this.treeRows(repo, group, buildTree(files), "", 1, out, t);
  }

  repoRows(repo, out, t) {
    const key = "r:" + repo.path, open = !this.collapsed.has(key), count = repo.staged.length + repo.changes.length;
    // A gap, then the repo as a band, so each repo reads as its own section.
    if (out.length) out.push({ h: 6, el: div().h(6).flex_none() });
    out.push({ h: REPO_ROW, el: h_flex().id("row-" + key).h(REPO_ROW).flex_none().px(6).gap(6).items_center().rounded(6).bg(t.raised).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(key, cx))
      .child(svg(ICON("book-marked")).size(14).flex_none().text_color(t.muted))
      // When space is short, the hint gives way first, then the name; the branch keeps up to 140px.
      .child(div().min_w(0).truncate().font_semibold().child(repo.name))
      .child(div().id("hint-" + key).flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(repo.hint)
        .when(Boolean(repo.hint), (e) => e.tooltip(repo.rel)))
      .child(svg(ICON("git-branch")).size(12).flex_none().text_color(t.dim))
      .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(repo.branch))
      .when(repo.ahead > 0 || repo.behind > 0, (e) => e.child(this.syncButton(repo, key, t)))
      .child(div().px(5).rounded(8).bg(t.background).text_size(10).text_color(t.muted).child(String(count))) });
    if (!open) return;
    if (repo.error) { out.push({ h: ROW, el: div().px(12).h(ROW).flex_none().truncate().text_size(11).text_color(t.ansi1).child(repo.error) }); return; }
    if (!count) out.push({ h: ROW, el: div().pl(GROUP_INDENT).h(ROW).flex_none().flex().items_center().text_size(12).text_color(t.dim).child("No changes") });
    this.groupRows(repo, "staged", "Staged", repo.staged, out, t);
    this.groupRows(repo, "changes", "Unstaged", repo.changes, out, t);
    if (repo.limited) out.push({ h: ROW, el: div().px(12).h(ROW).flex_none().text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files") });
  }

  // Commits to pull and to push, in the same style as the Spaces sidebar: only counts above zero, outgoing first.
  // Like VS Code, a click pulls when the branch is behind its upstream.
  syncButton(repo, key, t) {
    const pulling = this.pulling === repo.path, can = repo.behind > 0 && !this.busy;
    const commits = (n) => n + (n === 1 ? " commit" : " commits"), upstream = repo.upstream || "upstream";
    const tip = pulling ? "Pulling from " + upstream + "…"
      : repo.behind > 0 ? "Pull " + commits(repo.behind) + " from " + upstream
      : commits(repo.ahead) + " to push to " + upstream;
    return h_flex().id("sync-" + key).flex_none().h(20).px(4).gap(4).items_center().rounded(4).tooltip(tip)
      .when(can, (e) => e.cursor_pointer().hover((s) => s.bg(t.background)).on_click((_e, cx) => { cx.stop_propagation(); this.pull(repo, cx); }))
      .when(!can, (e) => e.on_click((_e, cx) => cx.stop_propagation()))
      .child(svg(ICON("refresh-cw")).size(12).flex_none().text_color(pulling ? t.foreground : t.dim))
      .when(repo.ahead > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child("↑" + repo.ahead)))
      .when(repo.behind > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child("↓" + repo.behind)));
  }

  editorRows(out, t) {
    const projects = loadProjects(), extra = projects[projectKey(this.root, this.on)] ?? [];
    const button = (id, label, onClick) => div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).border_1().border_color(t.border).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    out.push({ h: ROW, el: div().px(8).h(ROW).flex_none().flex().items_center().text_size(12).text_color(t.muted).child("Repositories in " + basename(this.root)) });
    out.push({ h: ROW, el: h_flex().h(ROW).flex_none().px(8).gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().child(basename(this.root))).child(div().text_size(11).text_color(t.dim).child("project root")) });
    for (const rel of extra) out.push({ h: ROW, el: h_flex().id("repo-" + rel).h(ROW).flex_none().px(8).gap(6).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().child(rel))
      .child(this.iconButton("remove-" + rel, "x", t, (cx) => this.removeRepo(rel, cx))) });
    out.push({ h: 38, el: h_flex().h(38).flex_none().px(8).gap(6).items_center()
      .when(!this.on, (e) => e.child(button("add-folder", "Add folder…", (cx) => this.addFolder(cx))))
      .child(button("done", "Done", (cx) => this.editRepos(cx))) });
  }

  // Asks before a discard, at the foot of the list card.
  discardBar(t) {
    const { files, label } = this.pending, n = files.length, untracked = files.filter(f => f.untracked).length;
    const button = (id, text, danger, onClick) => div().id(id).h(24).px(10).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
      .when(danger, (e) => e.bg(t.ansi1).text_color(t.background)).when(!danger, (e) => e.border_1().border_color(t.border))
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(text);
    return v_flex().px(10).py(8).gap(6).border_t(1).border_color(t.border).text_size(12)
      .child(div().child("Discard changes in " + label + (n > 1 ? " (" + n + " files)" : "") + "?"))
      .child(div().text_size(11).text_color(t.dim).child((untracked ? (untracked === n ? "The files are untracked and will be deleted. " : untracked + " untracked files will be deleted. ") : "") + "This cannot be undone."))
      .child(h_flex().gap(6).justify_end()
        .child(button("discard-cancel", "Cancel", false, (cx) => { this.pending = null; cx.notify(); }))
        .child(button("discard-yes", "Discard", true, (cx) => this.discard(cx))));
  }

  // The header of the diff view, like the Files view: back, the title, the file's path,
  // then which part it is (staged or not), its line counts, and the actions for this file.
  diffHeader(t) {
    const repo = this.repos.find(r => r.path === this.open.repo), file = repo?.[this.open.group].find(f => f.path === this.open.path);
    const path = [repo?.rel || repo?.name, this.open.path].filter(Boolean).join("/");
    // git reports no line counts for an untracked file: count the added lines of its preview.
    const add = file?.untracked ? this.rows.filter(r => r.kind === "+").length : file?.add ?? 0;
    const staged = this.open.group === "staged";
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("diff-back").w(20).flex_none().cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.back(cx)).child("←"))
      .child(div().flex_none().font_semibold().child("Changes"))
      .child(div().id("diff-path").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).tooltip(file?.old ? path + "\n" + (file.mark === "C" ? "Copied from " : "Renamed from ") + file.old : path).child(path))
      .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(staged ? "Staged" : "Unstaged"))
      .when(add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child("+" + add)))
      .when(file?.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child("−" + file.del)))
      .when(Boolean(repo && file) && !this.busy, (e) => e
        .when(staged, (e) => e.child(this.iconButton("diff-unstage", "minus", t, (cx) => this.unstage(repo, [file], cx))))
        .when(!staged && !file.conflict && !file.nestedRepo && !file.old, (e) => e.child(this.iconButton("diff-discard", "undo-2", t, (cx) => this.askDiscard(repo, [file], basename(file.path), cx))))
        .when(!staged && !file.conflict, (e) => e.child(this.iconButton("diff-stage", "plus", t, (cx) => this.stage(repo, [file], cx)))));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (!checking() && locationKey() !== this.locKey) this.refresh(cx);
    const t = theme();
    const foot = (e) => e
      .when(Boolean(this.pending), (e) => e.child(this.discardBar(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.note)));
    const card = v_flex().id("git-workbench").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    // A file click shows its diff in place of the list, like the Files view; back returns to the list.
    if (this.open) return foot(card
      .child(this.diffHeader(t))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())));
    const files = this.repos.flatMap(r => [...r.staged, ...r.changes]);
    const add = files.reduce((n, f) => n + (f.add || 0), 0), del = files.reduce((n, f) => n + (f.del || 0), 0);
    const out = [];
    if (this.editing && this.root) this.editorRows(out, t);
    else for (const repo of this.repos) this.repoRows(repo, out, t);
    const empty = this.error || (this.loading ? "Loading changes…" : this.root ? null : "No folder");
    // The scroll handle keeps the list's position while a diff is shown.
    const list = v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().track_scroll(this.listScroll).p(6).children(out.map(r => r.el))
      .when(!out.length || (!this.editing && Boolean(empty)), (e) => e.child(div().p(8).text_color(t.dim).child(empty || "No repositories")));
    return foot(card
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(files.length + " files · " + this.repos.length + (this.repos.length === 1 ? " repo" : " repos")))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child("+" + add)).child(div().text_size(11).text_color(t.ansi1).child("−" + del))
        .when(Boolean(this.root), (e) => e.child(div().id("edit-repos").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(this.editing, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.editRepos(cx))
          .child(svg(ICON("layers")).size(14).text_color(t.muted)))))
      .child(div().relative().flex_1().min_h(0).child(list).child(Scrollbar.vertical("changes-list").absolute().inset_0())));
  }

  close() { this.listScroll?.release(); }
}
