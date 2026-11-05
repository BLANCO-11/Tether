-- WHY THE `more` CONTINUATION LOOP STOPPED.
--
-- The loop applies up to `MAX_OPS_PER_TURN` ops for one instruction, and it can
-- end for six reasons. Five of them mean *the instruction was not fully carried
-- out* — the model declined, answered unparseably, had its op refused, re-sent a
-- no-op, or hit the cap — and until this column the turn recorded `applied` for
-- all six identically. Measured across 11 rebuilt UAT conversations: 6 flows
-- stopped at a transform having been asked to "email me", and there was no way
-- to tell which bound fired without re-running with a debugger attached.
--
-- That is I-120's shape at the top of the product: a value computed and
-- discarded, so the check was correct, its tests passed, and no behaviour
-- depended on the answer.
--
-- NULL means the loop never ran (a single-op turn) — deliberately distinct from
-- 'done', which means the model itself said nothing was left.
alter table flow_chat_turns add column if not exists more_stop_reason varchar(24);

comment on column flow_chat_turns.more_stop_reason is
  'Why the `more` continuation loop ended: done | declined | unparseable | refused | no_change | cap. NULL = the loop never ran. Anything but `done` or NULL means the instruction was not fully carried out.';
