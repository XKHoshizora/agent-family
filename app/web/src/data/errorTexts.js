// Why a friend, block or group action was refused, in Chinese. Input: the route's ApiError ({code, status, reason}).
// Each route lists the codes the service documents for it (app/service/README.md); anything else is generic.

const GENERIC = "操作没有成功，请稍后再试。";

/** Codes any route can answer. */
const COMMON = {
  rate_limited: "操作太频繁了，请稍等一分钟再试。",
  busy: "服务现在有点忙，请稍后再试。",
  network_error: "连不上服务，请检查网络后重试。",
  invalid_request: "填写的内容有误，请检查后再试。",
};

const FRIENDS = {
  lookup: {
    not_found: "没有找到这个账号。",
    invalid_request: "账号名由 3–24 位小写字母、数字或下划线组成。",
  },
  sendRequest: {
    not_found: "没有找到这个账号。",
    invalid_request: "不能添加自己为好友。",
    blocked: "你们之间存在拉黑，无法发送好友申请。",
    already_friends: "你们已经是好友了。",
    request_pending: "你们之间已有一条待处理的申请。",
  },
  accept: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期，请让对方重新发送。",
    blocked: "你们之间存在拉黑，无法同意这条申请。",
  },
  reject: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期。",
  },
  withdraw: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期。",
  },
  unfriend: {
    not_found: "你们已经不是好友了。",
  },
  block: {
    invalid_request: "不能拉黑自己。",
    not_found: "找不到这个用户。",
  },
  unblock: {},
};

const GROUPS = {
  create: {
    invalid_request: "群名称需要 1–60 个字，并至少选择 2 位好友。",
    forbidden: "没能创建群聊：有人已不是你的好友、与你存在拉黑，或群成员超过 500 人。",
  },
  rename: {
    forbidden: "只有群的创建者可以修改群名称。",
    not_found: "你已不在这个群聊中。",
    invalid_request: "群名称需要 1–60 个字，且只能一行。",
  },
  add: {
    not_found: "你已不在这个群聊中。",
    already_member: "对方已经在群里了。",
    forbidden: "没能添加：对方已不是你的好友、与你存在拉黑，或本群已满 500 人。",
  },
  remove: {
    forbidden: "只有群的创建者可以移除成员。",
    not_found: "这位成员已经不在群里了。",
  },
  leave: {
    not_found: "你已不在这个群聊中。",
  },
};

const pick = (table, action, error) => {
  const code = error?.code;
  return table[action]?.[code] ?? COMMON[code] ?? GENERIC;
};

/** action: lookup | sendRequest | accept | reject | withdraw | unfriend | block | unblock */
export const friendErrorText = (action, error) => pick(FRIENDS, action, error);
/** action: create | rename | add | remove | leave */
export const groupErrorText = (action, error) => pick(GROUPS, action, error);
