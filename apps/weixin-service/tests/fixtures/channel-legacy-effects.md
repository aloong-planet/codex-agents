# Legacy channel effect fixture

`channel-legacy-effects.sqlite` was generated from `DurableEffectLedger` at commit
`8b74b8f` using its public constructor, `prepare` and `settle` methods. It contains
one accepted `weixin_text` operation, with synthetic identifiers and no secrets.

The generation clock is fixed to `1800000000000`; the account is `old-bot`, target
`owner@im.wechat`, operation `legacy-operation`, attempt `legacy-attempt`.
The fixture tests the pre-Feishu CHECK constraint and preservation of its stored
identity when the current ledger expands supported effect kinds. Tests copy it
before opening; they never mutate the checked-in fixture.
