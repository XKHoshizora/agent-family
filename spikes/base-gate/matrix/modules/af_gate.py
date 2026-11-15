"""Gate-verification spike: Synapse module that defers every write decision to the
Agent Family rule service and fails closed when that service cannot answer.

Throwaway code for the base-selection gate. Not product code.
"""
import json
import logging
import urllib.request

from synapse.module_api import NOT_SPAM, ModuleApi, errors

logger = logging.getLogger(__name__)

# State a room's own members may never change, whatever their power level.
LOCKED_STATE = {
    "m.room.encryption",
    "m.room.history_visibility",
    "m.room.join_rules",
    "m.room.power_levels",
    "m.room.guest_access",
    "m.room.server_acl",
    "m.room.tombstone",
    "af.roles",
}


class AfGate:
    def __init__(self, config: dict, api: ModuleApi):
        self.api = api
        self.url = config["rules_url"].rstrip("/")
        self.system_user = config["system_user"]
        self.timeout = float(config.get("timeout", 2))
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event_allowed)
        api.register_spam_checker_callbacks(user_may_create_room=self.user_may_create_room)

    @staticmethod
    def parse_config(config: dict) -> dict:
        return config

    def _ask_blocking(self, payload: dict) -> bool:
        req = urllib.request.Request(
            self.url + "/check",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read()).get("allow") is True

    async def _ask(self, payload: dict) -> bool:
        # Any failure to get a clear "allow" is a refusal.
        try:
            return await self.api.defer_to_thread(self._ask_blocking, payload)
        except Exception as exc:  # noqa: BLE001 - fail closed on everything
            logger.warning("af_gate: rule service unavailable (%s); refusing %s", exc, payload.get("kind"))
            return False

    async def user_may_create_room(self, user_id: str, room_config: dict):
        # Rooms are created only by the Agent Family service on a user's behalf.
        if user_id == self.system_user:
            return NOT_SPAM
        return errors.Codes.FORBIDDEN

    async def check_event_allowed(self, event, state_events):
        sender = event.sender
        if sender == self.system_user:
            return True, None

        if event.is_state():
            if event.type == "m.room.member":
                target = event.state_key
                membership = event.content.get("membership")
                if membership == "leave" and target == sender:
                    return True, None  # anyone may leave
                ok = await self._ask(
                    {"kind": "member", "room": event.room_id, "sender": sender, "target": target, "membership": membership}
                )
                return ok, None
            if event.type in LOCKED_STATE:
                return False, None
            ok = await self._ask({"kind": "state", "room": event.room_id, "sender": sender, "type": event.type})
            return ok, None

        ok = await self._ask({"kind": "send", "room": event.room_id, "sender": sender, "type": event.type})
        return ok, None
