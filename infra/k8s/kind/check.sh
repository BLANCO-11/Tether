#!/usr/bin/env bash
# Checks for Foundry on the local kind cluster (infra/k8s/kind/up.sh first).
#
# Every isolation check has a CONTROL that must succeed — a "blocked" result means nothing if the
# target was down, so the same target is reached from a pod that is allowed to reach it.
# Exit 0 only when every check passes.
set -uo pipefail
NS=${NS:-foundry}                     # another release: NS=foundry-ext ./check.sh
DB_HOST=${DB_HOST:-postgres}          # an external database: DB_HOST=pg-external
BASE=${BASE:-http://localhost:8088}   # the ingress, as the browser reaches it (https://… for the TLS check)
PASS=0; FAIL=0
SBX=/repo/packages/server/.pi-sandboxes

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
ex()   { local d=$1; shift; kubectl -n "$NS" exec "deploy/$d" -c "$d" -- sh -c "$*"; }

# TCP probes, run inside a pod. 0 = connected; anything else = not reachable.
NODE_TCP='const s=require("net").connect({host:process.argv[1],port:+process.argv[2]});setTimeout(()=>process.exit(2),4000);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))'
PY_TCP='import socket,sys
s=socket.socket(); s.settimeout(4)
try: s.connect((sys.argv[1],int(sys.argv[2])))
except Exception: sys.exit(1)'
tcp() { # tcp <deploy> <host> <port>
  if [ "$1" = flow-runner ]; then
    kubectl -n "$NS" exec deploy/flow-runner -c flow-runner -- python -c "$PY_TCP" "$2" "$3" >/dev/null 2>&1
  else
    kubectl -n "$NS" exec "deploy/$1" -c "$1" -- node -e "$NODE_TCP" "$2" "$3" >/dev/null 2>&1
  fi
}
expect_open()   { if tcp "$1" "$2" "$3"; then ok "$1 → $2:$3 reachable"; else bad "$1 → $2:$3 should be reachable"; fi; }
expect_closed() { if tcp "$1" "$2" "$3"; then bad "$1 → $2:$3 should be BLOCKED"; else ok "$1 → $2:$3 blocked"; fi; }

# The pid of a container's main process (the one its entrypoint exec'd), found by command line.
# argv[0] must be node or python: a grep for the fragment would otherwise find its own command line.
main_pid() { # main_pid <deploy> <cmdline fragment>
  ex "$1" "for p in /proc/[0-9]*; do a0=\$(tr '\\0' '\\n' < \$p/cmdline 2>/dev/null | head -1); case \$a0 in */node|node|*/python*|python*) tr '\\0' ' ' < \$p/cmdline | grep -q '$2' && { echo \${p#/proc/}; break; };; esac; done"
}

LLM_HOST=$(kubectl -n "$NS" get secret foundry-env -o jsonpath='{.data.LLM_BASE_URL}' | base64 -d | sed -E 's#^https?://([^/:]+).*#\1#')

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "1. everything is up"
for d in server web ops-api forge forge-egress flow-runner; do
  if kubectl -n "$NS" rollout status "deploy/$d" --timeout=120s >/dev/null 2>&1; then ok "$d ready"; else bad "$d not ready"; fi
done
health=$(ex server "node -e \"fetch('http://localhost:4000/api/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))\"" 2>/dev/null)
status=$(printf '%s' "$health" | jq -r '.status // empty' 2>/dev/null)
others=$(printf '%s' "$health" | jq -r '[.components[] | select(.status != "up") | select((.name == "ops-api" and (.detail | test("HR demo"))) | not) | .name] | join(",")' 2>/dev/null)
if [ "$status" = ok ]; then ok "server /api/health: ok"
elif [ "$status" = degraded ] && [ -z "$others" ]; then
  ok "server /api/health: degraded ONLY because no hr_demo database exists (a fresh database; not a Kubernetes issue)"
else bad "server /api/health: ${status:-unreadable} (${others})"; fi
printf '%s' "$health" | jq -r '.components[] | "       \(.name): \(.status) — \(.detail)"' 2>/dev/null
if ex ops-api "node -e \"fetch('http://localhost:4004/healthz').then(r=>process.exit(r.ok?0:1))\"" >/dev/null 2>&1; then ok "ops-api /healthz"; else bad "ops-api /healthz"; fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "2. Pod Security: baseline refuses the sandbox pods, and only them (items 1, 2)"
kubectl create namespace psa-probe --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace psa-probe --overwrite pod-security.kubernetes.io/enforce=baseline >/dev/null
for d in forge flow-runner web server ops-api forge-egress; do
  out=$(kubectl -n "$NS" get deploy "$d" -o json \
    | jq '{apiVersion:"v1",kind:"Pod",metadata:{name:"psa-probe"},spec:.spec.template.spec}' \
    | kubectl apply -n psa-probe --dry-run=server -f - 2>&1)
  refused=no; printf '%s' "$out" | grep -q 'violates PodSecurity' && refused=yes
  case $d in
    forge|flow-runner)
      if [ $refused = yes ]; then ok "$d refused under baseline ($(printf '%s' "$out" | grep -o 'non-default capabilities[^)]*)\|[a-z]*AppArmor[^;]*' | head -1))"; else bad "$d was ADMITTED under baseline"; fi ;;
    *)
      if [ $refused = no ]; then ok "$d admitted under baseline"; else bad "$d refused under baseline: $out"; fi ;;
  esac
done
kubectl delete namespace psa-probe --wait=false >/dev/null 2>&1

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "3. sandbox boot: /proc hidden, SYS_ADMIN gone from the running process (item 3)"
for spec in "forge:host.mjs" "flow-runner:runner.server"; do
  d=${spec%%:*}; frag=${spec#*:}
  if kubectl -n "$NS" logs "deploy/$d" -c "$d" 2>/dev/null | grep -q refusing_to_start; then bad "$d logged refusing_to_start"; fi
  opts=$(ex "$d" "awk '\$2==\"/proc\" && \$3==\"proc\" {print \$4}' /proc/mounts | head -1")
  case $opts in *hidepid=invisible*|*hidepid=2*) ok "$d /proc mounted hidepid ($opts)";; *) bad "$d /proc options: ${opts:-none}";; esac
  pid=$(main_pid "$d" "$frag")
  if [ -n "$pid" ]; then
    bnd=$(ex "$d" "awk '/^CapBnd/ {print \$2}' /proc/$pid/status" 2>/dev/null)
    if [ -z "$bnd" ]; then bad "$d: could not read the main process's capabilities (pid $pid)"
    elif [ $(( 0x$bnd >> 21 & 1 )) -eq 0 ]; then ok "$d main process (pid $pid) has no SYS_ADMIN in its bounding set"; else bad "$d main process still holds SYS_ADMIN (CapBnd $bnd)"; fi
  else bad "$d: main process not found"; fi
  # Not a failure: a `kubectl exec` shell is NOT a child of the entrypoint and keeps the pod's capabilities.
  eff=$(ex "$d" "awk '/^CapEff/ {print \$2}' /proc/self/status")
  [ $(( 0x$eff >> 21 & 1 )) -eq 1 ] && printf '       note: a kubectl exec shell in %s has SYS_ADMIN — keep pods/exec out of everyday RBAC\n' "$d"
done

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "4. one conversation cannot see another's processes or folder (items 3, 5)"
# Run as root inside the pod (like the forge host / runner): uid 30001 is one conversation, 30002 another.
ISOLATION='
dir=$1
as() { u=$1; shift; setpriv --reuid=$u --regid=$u --clear-groups --inh-caps=-all "$@"; }
COUNT="n=0; for p in /proc/[0-9]*; do [ \"\$(stat -c %u \$p 2>/dev/null)\" = 30001 ] && n=\$((n+1)); done; echo \$n"
rm -rf "$dir"; mkdir -p "$dir/a"; chmod 700 "$dir/a"; chown 30001:30001 "$dir/a"
as 30001 sh -c "echo private > $dir/a/f; sleep 15" &
sleep 2
echo root_sees=$(sh -c "$COUNT")
echo other_sees=$(as 30002 sh -c "$COUNT" 2>/dev/null || echo err)
echo other_reads=$(as 30002 cat "$dir/a/f" 2>/dev/null || echo denied)
echo owner_reads=$(as 30001 cat "$dir/a/f" 2>/dev/null || echo denied)
echo owner=$(stat -c %u:%a "$dir/a")
kill $! 2>/dev/null; rm -rf "$dir"
'
for d in forge flow-runner; do
  dir=$([ $d = forge ] && echo "$SBX/.k8s-check" || echo "/runs/.k8s-check")
  out=$(printf '%s' "$ISOLATION" | kubectl -n "$NS" exec -i "deploy/$d" -c "$d" -- sh -s -- "$dir" 2>&1)
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  [ "$(get owner)" = "30001:700" ] && ok "$d chown/chmod work on its volume (30001:700)" || bad "$d ownership: $(get owner) — $out"
  [ "$(get root_sees)" -ge 1 ] 2>/dev/null && ok "$d control: root sees uid 30001's process" || bad "$d control failed: root_sees=$(get root_sees)"
  [ "$(get other_sees)" = 0 ] && ok "$d uid 30002 sees none of uid 30001's processes" || bad "$d uid 30002 sees $(get other_sees) of uid 30001's processes"
  [ "$(get owner_reads)" = private ] && ok "$d control: the owner reads its own file" || bad "$d owner could not read its file"
  [ "$(get other_reads)" = denied ] && ok "$d uid 30002 cannot read uid 30001's folder" || bad "$d uid 30002 READ the file: $(get other_reads)"
done

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "5. server and forge share the chat folder at the same path (item 4)"
stamp=k8s-check-$RANDOM
ex server "echo $stamp > $SBX/.$stamp" >/dev/null
got=$(ex forge "cat $SBX/.$stamp 2>/dev/null")
[ "$got" = "$stamp" ] && ok "a file the server writes is read by forge" || bad "forge could not read the server's file"
ex server "rm -f $SBX/.$stamp" >/dev/null
ex server "touch /repo/data/mocks/.$stamp && rm /repo/data/mocks/.$stamp" >/dev/null 2>&1 && ok "mocks volume writable by the server (item 12)" || bad "mocks volume not writable"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "6. network isolation — each block has a control (item 9)"
expect_open   server      "$DB_HOST" 5432          # control for the postgres blocks
expect_open   server      ops-api 4004           # control for the ops-api blocks
expect_open   server      forge 4100
expect_open   server      flow-runner 4006
expect_open   forge       server 4000
expect_open   forge       forge-egress 3128
expect_closed forge       "$DB_HOST" 5432
expect_closed forge       ops-api 4004
expect_closed forge       flow-runner 4006
expect_closed forge       1.1.1.1 443
expect_closed forge       "$LLM_HOST" 443        # even the AI gateway — only via the proxy
expect_open   flow-runner server 4000
expect_closed flow-runner "$DB_HOST" 5432
expect_closed flow-runner ops-api 4004
expect_closed flow-runner forge 4100
expect_closed flow-runner 1.1.1.1 443
expect_closed forge-egress "$DB_HOST" 5432
expect_closed forge-egress server 4000
expect_open   forge-egress "$LLM_HOST" 443       # control: its one job
expect_closed web         "$DB_HOST" 5432
expect_closed web         ops-api 4004
expect_closed web         forge 4100
expect_closed web         flow-runner 4006

proxy() { # proxy <target host:port> → the HTTP status forge-egress answers a CONNECT with
  kubectl -n "$NS" exec deploy/forge -c forge -- node -e '
    const r=require("http").request({host:"forge-egress",port:3128,method:"CONNECT",path:process.argv[1]});
    r.on("connect",res=>{console.log(res.statusCode);process.exit(0)});
    r.on("response",res=>{console.log(res.statusCode);process.exit(0)});
    r.on("error",e=>{console.log("error");process.exit(0)});
    setTimeout(()=>{console.log("timeout");process.exit(0)},8000); r.end();' "$1" 2>/dev/null
}
c=$(proxy "$LLM_HOST:443"); [ "$c" = 200 ] && ok "forge → proxy → AI gateway: 200" || bad "forge → proxy → AI gateway: $c"
c=$(proxy "example.com:443"); [ "$c" != 200 ] && ok "forge → proxy → example.com refused ($c)" || bad "proxy let example.com through"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
if kubectl -n "$NS" get deploy connector >/dev/null 2>&1; then
section "6b. plugins: the connector reaches only its proxy, the proxy only public addresses (plugins.enabled)"
for d in connector connector-egress; do
  if kubectl -n "$NS" rollout status "deploy/$d" --timeout=120s >/dev/null 2>&1; then ok "$d ready"; else bad "$d not ready"; fi
done
expect_open   server           connector 4010          # control: its one caller
expect_open   connector        connector-egress 3128   # control: its one way out
expect_closed connector        "$DB_HOST" 5432
expect_closed connector        server 4000
expect_closed connector        ops-api 4004
expect_closed connector        1.1.1.1 443
expect_closed connector        registry.npmjs.org 443  # even the registry — only via the proxy
expect_closed forge            connector 4010
expect_closed web              connector 4010
expect_closed connector-egress "$DB_HOST" 5432
expect_closed connector-egress server 4000
expect_open   connector-egress registry.npmjs.org 443  # control: public HTTPS
names=$(kubectl -n "$NS" get deploy connector -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.valueFrom.secretKeyRef.key}{" "}{end}' | xargs)
[ "$names" = "PLUGINS_CONNECTOR_SECRET PLUGINS_EGRESS_SECRET" ] && ok "connector pod spec references only its two secrets" || bad "connector pod spec references: $names"
# End to end: the server asks the connector to install a pinned piece; npm reaches the registry only through the proxy.
got=$(ex server "node -e \"fetch('http://connector:4010/pieces/install',{method:'POST',headers:{'content-type':'application/json','x-connector-secret':process.env.PLUGINS_CONNECTOR_SECRET},body:JSON.stringify({name:'@activepieces/piece-github',version:'0.11.0',integrity:'sha512-fpp3p3BLjJtRkNMK3CDstIitGIrF1Na5hlqfRHo5EiL7e8XXxO6rPorkFTxCNw+zMu71WhZp8AagCYvuXUD3sw==',hosts:['api.github.com']})}).then(async r=>console.log(r.status,(await r.json()).actions?.length))\"" 2>&1 | tail -1)
case $got in "200 "[1-9]*) ok "server → connector installs a pinned piece through the proxy ($got actions)";; *) bad "piece install through the connector: $got";; esac
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "7. each sandbox pod gets only its own secret (item 16)"
for spec in "flow-runner:FLOW_RUNNER_SECRET" "forge:FORGE_HOST_SECRET"; do
  d=${spec%%:*}; want=${spec#*:}
  names=$(kubectl -n "$NS" get deploy "$d" -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.valueFrom.secretKeyRef.key}{" "}{end}' | xargs)
  [ "$names" = "$want" ] && ok "$d pod spec references only $want" || bad "$d pod spec references: $names"
done
rpid=$(main_pid flow-runner runner.server)
envnames=$([ -n "$rpid" ] && ex flow-runner "tr '\\0' '\\n' < /proc/$rpid/environ | cut -d= -f1" 2>/dev/null)
leak=$(printf '%s\n' "$envnames" | grep -E 'PARENT_API_KEY|CREDENTIAL_ENC_KEY|LLM_API_KEY|OPS_API_KEY|DATABASE_URL' || true)
if [ -z "$envnames" ]; then bad "flow-runner: could not read the runner's environment (pid ${rpid:-not found})"
elif [ -z "$leak" ]; then ok "flow-runner's process (pid $rpid) holds no app secret: $(printf '%s' "$envnames" | xargs)"
else bad "flow-runner's process holds: $leak"; fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "8. through the ingress, from this Mac (items 14, 22)"
if [ -z "$(kubectl -n "$NS" get ingress -o name 2>/dev/null)" ]; then
  echo "  (skipped: no ingress in $NS)"
else
code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 $BASE/login)
[ "$code" = 200 ] && ok "web /login via ingress: 200" || bad "web /login via ingress: $code"
body=$(curl -sk --max-time 10 -X POST $BASE/api/triggers/not-a-token/webhook -H 'content-type: application/json' -d '{}')
printf '%s' "$body" | jq -e . >/dev/null 2>&1 && ok "/api/triggers reaches the server (JSON: $(printf '%s' "$body" | head -c 80))" || bad "/api/triggers did not reach the server: $(printf '%s' "$body" | head -c 120)"
ws=$(curl -sk -i --http1.1 --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/ws/flow-execution?ticket=not-a-ticket" 2>/dev/null | head -1 | tr -d '\r')
case $ws in *" 101"*|*" 401"*|*" 403"*|*" 400"*) ok "WebSocket upgrade reaches the server: $ws";; *) bad "WebSocket via ingress: ${ws:-no response}";; esac
routed=$(kubectl -n "$NS" get ingress -o jsonpath='{range .items[*].spec.rules[*].http.paths[*]}{.backend.service.name}{"\n"}{end}' | sort -u | xargs)
[ "$routed" = "server web" ] && ok "the ingress routes only to server and web (ops-api, forge, flow-runner, postgres unreachable from outside)" || bad "the ingress routes to: $routed"
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "9. memory: a runaway conversation or run dies ALONE (item 8)"
restarts() { kubectl -n "$NS" get pod -l "app.kubernetes.io/component=$1" -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}'; }
f0=$(restarts forge); r0=$(restarts flow-runner)

# 9a. The layout entrypoint.sh sets up, exercised the way host.mjs uses it: a conversation's group under work/.
MEMORY='
C=/sys/fs/cgroup; W=$C/work
echo layout=$([ -f $W/cgroup.procs ] && echo yes || echo no)
echo root_write=$(echo 99G > $C/memory.max 2>/dev/null && echo yes || echo refused)
echo root_limit=$(cat $C/memory.max) work_cap=$(cat $W/memory.max)
mk() { mkdir -p $W/conv-$1; echo $2 > $W/conv-$1/memory.max; echo 1 > $W/conv-$1/memory.oom.group; }
hog="const a=[];setInterval(()=>a.push(Buffer.alloc(64e6,1)),20)"
run_in() { sh -c "echo \$\$ > $W/conv-$1/cgroup.procs; exec setpriv --reuid=$1 --regid=$1 --clear-groups --inh-caps=-all node -e \"$hog\"" >/dev/null 2>&1; }
mk 39001 300M; run_in 39001; echo single_exit=$?
echo single_kills=$(sed -n "s/^oom_kill //p" $W/conv-39001/memory.events)
rmdir $W/conv-39001
# Two conversations, each allowed 3/4 of work: together they pass work`s cap, which must not reach the container.
per=$(( $(cat $W/memory.max) * 3 / 4 ))
mk 39002 $per; mk 39003 $per
run_in 39002 & a=$!; run_in 39003 & b=$!
wait $a; ea=$?; wait $b; eb=$?
echo pair_exits=$ea,$eb
rmdir $W/conv-39002 $W/conv-39003
'
out=$(printf '%s' "$MEMORY" | kubectl -n "$NS" exec -i deploy/forge -c forge -- sh -s 2>&1)
get() { printf '%s\n' "$out" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; }
[ "$(get layout)" = yes ] && ok "forge: memory groups are set up (work cap $(get work_cap) under pod limit $(get root_limit))" || bad "forge: no memory groups — $out"
[ "$(get root_write)" = refused ] && ok "forge: the pod's own memory limit is read-only, even to root" || bad "forge: root could RAISE the pod's memory limit"
[ "$(get single_exit)" = 137 ] && [ "$(get single_kills)" -ge 1 ] 2>/dev/null && ok "forge: a conversation over its own cap is killed (exit 137, in its group)" || bad "forge: runaway conversation: exit $(get single_exit), kills $(get single_kills)"
[ "$(get pair_exits)" = 137,137 ] && ok "forge: two that together pass the shared cap are killed by group, not the container" || bad "forge: pair exits $(get pair_exits)"
f1=$(restarts forge)
[ "$f0" = "$f1" ] && ok "forge pod survived all of it (restarts $f1)" || bad "forge container was restarted ($f0 → $f1) — the kill reached the whole pod"

# 9b. host.mjs itself: a real conversation (pi --mode rpc, no model call) starts INSIDE its own group, and the group
# is gone when the conversation ends.
ex server "mkdir -p $SBX/k8scheck/conv1/sandbox" >/dev/null
kubectl -n "$NS" exec deploy/server -c server -- node -e '
  const s=require("net").connect({host:"forge",port:4100});
  s.write(JSON.stringify({secret:process.env.FORGE_HOST_SECRET,workspaceId:"k8scheck",sessionId:"conv1",args:["--mode","rpc"],env:{}})+"\n");
  setTimeout(()=>{s.destroy();process.exit(0)},7000);' >/dev/null 2>&1 &
probe=$!
sleep 4
where=$(ex forge 'for p in /proc/[0-9]*; do u=$(stat -c %u $p 2>/dev/null); [ "${u:-0}" -ge 30000 ] && [ "$u" -le 59999 ] || continue; echo "$u $(cat $p/cgroup)"; break; done')
wait $probe
sleep 5   # the host's kill grace
left=$(ex forge 'ls -d /sys/fs/cgroup/work/conv-* 2>/dev/null | wc -l')
ex server "rm -rf $SBX/k8scheck" >/dev/null
uid=${where%% *}; cg=${where#* }
[ -n "$where" ] && [ "$cg" = "0::/work/conv-$uid" ] && ok "forge: a real conversation (uid $uid) runs in its own group ($cg)" || bad "forge: conversation process placement: '${where:-no conversation process found}'"
[ "$left" = 0 ] && ok "forge: the conversation's group is removed when it ends" || bad "forge: $left conversation group(s) left behind"

# 9c. flow-runner, through its own API: one run whose step runs away, one ordinary run beside it.
id=k8s-check-$RANDOM
kubectl -n "$NS" exec deploy/server -c server -- node -e '
  const id=process.argv[1];
  const job=(n,code)=>({flowExecutionId:`${id}-${n}`,token:"t",serverBase:"http://server:4000",stepTimeoutSeconds:60,
    workflow:{steps:[{id:"s",entry:"s.py"}]},files:{"s.py":code},inputs:{}});
  const post=(j)=>fetch("http://flow-runner:4006/runs",{method:"POST",headers:{"content-type":"application/json","x-runner-secret":process.env.FLOW_RUNNER_SECRET},body:JSON.stringify(j)}).then(r=>r.status);
  Promise.all([
    post(job("hog","def run(p, i):\n    a = []\n    while True:\n        a.append(b\"\\x01\" * (64 * 1024 * 1024))\n")),
    post(job("calm","def run(p, i):\n    return {\"ok\": True}\n")),
  ]).then(s=>console.log(s.join(",")));' "$id" >/dev/null 2>&1
hog_line=""; calm_line=""
for _ in $(seq 1 60); do
  logs=$(kubectl -n "$NS" logs deploy/flow-runner -c flow-runner --since=5m 2>/dev/null)
  hog_line=$(printf '%s\n' "$logs" | grep "\"$id-hog\"" | grep run_failed | head -1)
  calm_line=$(printf '%s\n' "$logs" | grep "\"$id-calm\"" | grep run_done | head -1)
  [ -n "$hog_line" ] && [ -n "$calm_line" ] && break
  sleep 2
done
printf '%s' "$hog_line" | grep -q "ran out of memory" && ok "flow-runner: the runaway step failed with: $(printf '%s' "$hog_line" | grep -o 'ran out of memory[^"]*' | head -c 90)…" || bad "flow-runner: runaway run: ${hog_line:-no run_failed line}"
printf '%s' "$calm_line" | grep -q '"status": *"succeeded"' && ok "flow-runner: the run beside it succeeded" || bad "flow-runner: ordinary run: ${calm_line:-no run_done line}"
r1=$(restarts flow-runner)
[ "$r0" = "$r1" ] && ok "flow-runner pod survived (restarts $r1)" || bad "flow-runner container was restarted ($r0 → $r1)"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────
section "10. restarts (items 6, 7)"
for d in forge flow-runner; do
  port=$([ $d = forge ] && echo 4100 || echo 4006)
  t0=$(date +%s)
  kubectl -n "$NS" delete pod -l "app.kubernetes.io/component=$d" --wait=true >/dev/null
  kubectl -n "$NS" wait --for=condition=Ready pod -l "app.kubernetes.io/component=$d" --timeout=120s >/dev/null 2>&1
  # A new pod gets a new IP, and the network plugin programs its policy a moment after it is Ready.
  back=no; for _ in $(seq 1 15); do tcp server "$d" "$port" && { back=yes; break; }; sleep 2; done
  if [ $back = yes ]; then ok "$d replaced and reachable again in $(( $(date +%s) - t0 ))s"; else bad "$d did not come back within 2.5 min"; fi
done
status=$(ex server "node -e \"fetch('http://localhost:4000/api/health').then(r=>r.json()).then(j=>console.log(j.status))\"" 2>/dev/null)
case $status in ok|degraded) ok "server answering health after both restarts ($status, as before)";; *) bad "server health after restarts: $status";; esac

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
