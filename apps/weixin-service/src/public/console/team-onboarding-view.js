// The rules of the 团队管理 page's onboarding block (team-management::US-002): from one team of the view the service reports,
// what the QR area, the steps and the actions show. It touches no page element: team.js draws what `onboardingView` returns.
// The page loads this file as a classic script and the unit tests import it as a module, so it publishes itself on globalThis.
(() => {
  /** How a send ended, as the page words it for an announcement and for a test message. */
  const SENT = { accepted: "飞书已接收", failed: "发送失败 · 不会自动重发", unknown: "发送结果未知 · 不会自动重发", sending: "正在发送" };

  const stepState = (outcome) => !outcome ? "todo" : outcome.status === "done" ? "done" : outcome.status === "review" ? "review" : "blocked";
  function credentialNote(outcome) {
    if (outcome?.status === "review") return "应用版本尚未发布，或还没有被企业管理员启用。审核通过后点「重新检查」。";
    if (outcome?.status === "action") {
      return { bad_credentials: "凭证校验没有通过：App ID 与 App Secret 不匹配。请替换 App Secret 后保存。", secret_missing: "还没有填写 App Secret。填写后保存，会自动开始检查。" }[outcome.reason]
        ?? "暂时连不上飞书，稍后点「重新检查」。";
    }
    return "确认凭证可用，读取机器人名称。";
  }
  function joinNote(group, outcome, credentialsDone) {
    if (outcome?.status === "done") return "机器人已在群里。";
    if (outcome) {
      return {
        owner_only: `${group}只允许群主和管理员添加成员，Sam 无法拉入。请在飞书调整群设置，或由群主手动添加。`,
        pending_approval: `${group}开启了入群审批，Sam 的添加申请正等待群主或管理员批准；批准后点「重新检查」。`,
        refused: `飞书没有接受把机器人加入${group}。请确认应用已开启机器人能力，再点「重新检查」。`,
        not_joined: `机器人还不在${group}里。请把机器人加入该群后点「重新检查」。`,
      }[outcome.reason] ?? "暂时连不上飞书，稍后点「重新检查」。";
    }
    return credentialsDone ? "尚未检查，可点「重新检查」。" : "等待前面的步骤完成。";
  }

  /**
   * What the QR area shows for a team: its choice of QR creation is not saved yet (`unsaved`), the code is being fetched
   * (`generating`), it waits for the scan (`scan`), it ran out or the scan did not finish (`expired`), Feishu gave no code
   * (`unreachable`), or the scan has created the application (`created`).
   */
  function qrState(team) {
    const creation = team?.method === "qr" ? team.creation : undefined;
    if (!creation) return "unsaved";
    if (creation.status === "done") return "created";
    if (creation.status === "waiting") return creation.codeExpiresAt ? "scan" : "generating";
    return creation.reason === "unreachable" ? "unreachable" : "expired";
  }
  const QR_STEP = { unsaved: "todo", generating: "active", scan: "active", expired: "blocked", unreachable: "blocked", created: "done" };
  const QR_BOX = { unsaved: "保存后显示", generating: "正在生成", expired: "二维码已过期", unreachable: "未取得二维码" };
  const QR_TEXT = { generating: "正在向飞书取二维码。", scan: "用飞书扫码，在手机上确认创建。创建完成后，App ID 与 App Secret 自动回填，你不需要复制任何凭证。",
    expired: "这个二维码已过期，或扫码没有完成。刷新后重新扫码即可，不会创建重复的应用。", unreachable: "暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」再试。" };
  const QR_STEP_NOTE = { expired: "二维码已过期，或扫码没有完成。请刷新二维码后重新扫码。", unreachable: "暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」。" };

  /**
   * The QR area: the created application, or the box (the code's image while it waits for the scan, a caption otherwise),
   * the text beside it, and 「刷新二维码」 where it does something, as the main action once it is the way forward.
   */
  function qrArea(state, team) {
    if (state === "created") return { created: team.creation.appId };
    // A team that already has an application keeps it until the scan; the text says what the scan then replaces.
    const text = state !== "unsaved" ? QR_TEXT[state]
      : `保存团队后，这里显示二维码；用飞书扫码即可创建应用。${team?.leader.appId ? `扫码创建的新应用会替换现在的应用 ${team.leader.appId}，替换后团队在各群重新接入。` : ""}`;
    return { image: state === "scan", box: QR_BOX[state] ?? null, text, refresh: state === "scan" ? "plain" : QR_STEP[state] === "blocked" ? "main" : null };
  }

  /** The note of step 2 (`configure`) or step 3 (`publish`) of an application created by QR code. */
  function createdStepNote(step, outcome) {
    if (outcome?.status === "review") return "已提交发布，等待企业管理员审核。审核通过后点「重新检查」。";
    if (outcome?.status === "action") {
      if (outcome.reason === "unreachable") return "暂时连不上飞书，稍后点「重新检查」。";
      return step === "configure" ? "飞书没有接受自动配置。请在飞书开发者后台为这个应用开启机器人能力，并开通发送消息、读取群信息等权限，完成后点「重新检查」。"
        : "飞书没有接受自动提交发布。请在飞书开发者后台为这个应用创建版本并提交发布，完成后点「重新检查」。";
    }
    return step === "configure" ? "自动申请发送消息、读取群信息等所需权限，并开启机器人能力。" : "自动提交发布，企业管理员审核通过后生效；管理员开启免审可跳过审核。";
  }
  const TEST_STEP = { accepted: "done", failed: "blocked", unknown: "blocked", sending: "active" };

  /**
   * The onboarding block of one list entry.
   * - `fixed`: the entry is Sam, whose application comes from the local configuration.
   * - `team`: the saved team as the service reports it; absent for Sam and for a team not saved yet.
   * - `method`: the 接入方式 chosen in the editor, which a save has not necessarily stored.
   * - `groups`: the dispatch groups with their names.
   * - `confirming`: the owner opened the test message's confirmation.
   *
   * Returns whether the block is in QR creation (`qr`), the QR area (`area`, null for an existing application), the steps
   * with a row per group where a step has them, whether 「重新检查」 and the test message are offered, and the confirmation's
   * text while it is open. A step's `state` is one of todo, active, review, blocked and done.
   */
  function onboardingView({ fixed, team, method, groups, confirming }) {
    const groupName = (chatId) => groups.find((group) => group.chatId === chatId)?.name ?? chatId;
    const qr = !fixed && method === "qr";
    const code = qr ? qrState(team) : null;
    // Until the scan has created the application, steps 2 to 6 belong to an application that does not exist yet.
    const pending = qr && code !== "created";
    const live = (team?.bindings ?? []).filter(({ state }) => state !== "draining");
    const done = { status: "done" };
    // A binding that accepts work has passed the check and the join, even when it came from the local configuration without recorded checks.
    const credentials = pending ? undefined : fixed ? done : team?.credentials ?? (live.some(({ state }) => state === "accepting") ? done : undefined);
    const joins = fixed ? groups.map(({ chatId }) => ({ chatId, join: done }))
      : live.map(({ chatId, state, join }) => ({ chatId, join: pending ? undefined : join ?? (state === "accepting" ? done : undefined) }));
    const checked = stepState(credentials);
    const joined = !joins.length ? "todo" : joins.some(({ join }) => stepState(join) === "blocked") ? "blocked" : joins.every(({ join }) => stepState(join) === "done") ? "done" : "todo";
    // Step 6 has one row per group a test message went to; a failed or unknown send makes the step need action.
    const tests = fixed || pending ? [] : live.flatMap(({ chatId }) => team.tests[chatId] ? [[chatId, team.tests[chatId].status]] : []);
    const tested = fixed ? "done" : !tests.length ? "todo" : tests.some(([, status]) => status === "sending") ? "active" : tests.some(([, status]) => status !== "accepted") ? "blocked" : "done";
    const steps = [
      ...(qr ? [
        { state: QR_STEP[code], title: "扫码创建应用", note: QR_STEP_NOTE[code] ?? "用飞书扫码并确认，创建一个新的智能体应用；不会选中已有应用，凭证自动回填。", rows: [] },
        { state: pending ? "todo" : stepState(team.configure), title: "配置权限与机器人能力", note: createdStepNote("configure", pending ? undefined : team.configure), rows: [] },
        { state: pending ? "todo" : stepState(team.publish), title: "发布版本", note: createdStepNote("publish", pending ? undefined : team.publish), rows: [] }] : []),
      { state: checked, title: "校验凭证并读取机器人信息", note: credentialNote(credentials), rows: [] },
      { state: joined, title: "加入所绑定的群", note: joins.length ? "由 Sam 把机器人拉进每个绑定的群。" : "先在下面勾选所属群。",
        rows: joins.map(({ chatId, join }) => ({ group: groupName(chatId), state: stepState(join), note: joinNote(groupName(chatId), join, checked === "done") })) },
      { state: tested, title: "发送测试消息", note: "可选：向所绑定的群发一条测试消息，发送前需你确认；不发也不影响接单。",
        rows: tests.map(([chatId, status]) => ({ group: groupName(chatId), state: TEST_STEP[status], note: SENT[status] })) },
    ];
    // 重新检查 and the test message are offered once they can do something: for a saved team with an application to check, and
    // for one that accepts work in a group. The message is sent only from the confirmation.
    const accepting = !team || pending ? [] : team.bindings.filter(({ state }) => state === "accepting").map(({ chatId }) => chatId);
    const confirm = confirming && accepting.length
      ? `将以 ${team.leader.name}（${team.teamName}）的机器人向${accepting.map(groupName).join("、")}${accepting.length > 1 ? "各" : ""}发一条测试消息，群里的成员都会看到：「${team.testMessage}」` : null;
    return { qr, area: qr ? qrArea(code, team) : null, steps, recheck: Boolean(team) && !pending, test: accepting.length > 0, confirm };
  }

  globalThis.TeamOnboardingView = { onboardingView, SENT };
})();
