#!/system/bin/sh
# Temporary, metadata-only probe for task-owned Android qualification emulators.
set -eu
umask 077

fail() {
  printf '%s\n' "Android kernel probe: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail 'expected ACTION WRITER_TID DATA_FD'
action=$1
tid=$2
data_fd=$3
case "$action" in start|read|stop|cleanup|memory) ;; *) fail 'invalid action' ;; esac
for number in "$tid" "$data_fd"; do
  case "$number" in ''|*[!0-9]*) fail 'arguments must be decimal integers' ;; esac
  [ "${#number}" -le 10 ] || fail 'numeric argument out of range'
  [ "$number" -le 2147483647 ] || fail 'numeric argument out of range'
done
[ "$tid" -gt 0 ] || fail 'writer TID must be positive'

tracefs=/sys/kernel/tracing
group=oc_adb_kernel_$tid
state=/data/local/tmp/$group
instance=$tracefs/instances/$group
events='alloc_enter alloc_return packet_enter packet_return copy_enter copy_return'

section() { printf 'OPENCLAW_KERNEL_SECTION %s\n' "$1"; }

memory() {
  section uptime
  cat /proc/uptime
  section meminfo
  grep -E '^(MemTotal|MemAvailable|MemFree|SwapFree|Slab|SReclaimable|SUnreclaim|KernelStack|PageTables):[[:space:]]+[0-9]+[[:space:]]+kB$' /proc/meminfo
  section buddyinfo
  cat /proc/buddyinfo
  section vmstat
  grep -E '^(oom_kill|allocstall_[a-z_]+|pgscan_direct[a-z_]*|pgsteal_direct[a-z_]*|compact_fail|compact_success|compact_stall|pgalloc_[a-z_]+)[[:space:]]+[0-9]+$' /proc/vmstat
}

require_owner() {
  [ -d "$state" ] && [ ! -L "$state" ] || fail 'owned state is missing'
  [ "$(cat "$state/owner")" = "$tid $data_fd" ] || fail 'owned state identity mismatch'
}

profile() {
  section profile
  awk '
    $1 ~ /^(alloc_enter|alloc_return|packet_enter|packet_return|copy_enter|copy_return)$/ {
      print; count++
    }
    END { if (count != 6) exit 1 }
  ' "$tracefs/kprobe_profile" || fail 'probe profile coverage is incomplete'
}

trace_snapshot() {
  section trace
  cat "$instance/trace"
}

stop_sampler() {
  [ -f "$state/sampler-pid" ] || return 0
  : > "$state/sampler-stop"
  remaining=5
  while [ ! -f "$state/sampler-done" ] && [ "$remaining" -gt 0 ]; do
    sleep 1
    remaining=$((remaining - 1))
  done
  [ -f "$state/sampler-done" ]
}

case "$action" in
  memory)
    memory
    ;;
  start)
    release=$(uname -r)
    arch=$(uname -m)
    section identity
    printf 'release=%s\narch=%s\ntid=%s\ndata_fd=%s\n' "$release" "$arch" "$tid" "$data_fd"
    case "$arch" in
      x86_64) write_syscall=1 ;;
      aarch64) write_syscall=64 ;;
      *) fail 'kernel architecture has not been reviewed' ;;
    esac
    printf 'write_syscall=%s\n' "$write_syscall"
    section symbols
    awk '
      $3 == "__alloc_skb" || $3 == "virtio_transport_alloc_skb" || $3 == "_copy_from_iter" {
        print; seen[$3] = 1
      }
      END { if (length(seen) != 3) exit 1 }
    ' /proc/kallsyms || fail 'required kernel symbols are unavailable'
    case "$release" in
      6.6.66-android15-8-gd0c43a640eab*) ;;
      *) fail 'kernel build has not been source-reviewed' ;;
    esac
    [ -d "$tracefs/instances" ] && [ -w "$tracefs/kprobe_events" ] || fail 'tracefs is unavailable'
    [ -d "$tracefs/events/raw_syscalls/sys_enter" ] &&
      [ -d "$tracefs/events/raw_syscalls/sys_exit" ] || fail 'raw syscall events are unavailable'
    [ ! -e "$instance" ] && [ ! -e "$tracefs/events/$group" ] || fail 'probe namespace already exists'
    # This kernel's profile omits the group; duplicate event names make misses ambiguous.
    if grep -Eq '^[[:space:]]*(alloc_enter|alloc_return|packet_enter|packet_return|copy_enter|copy_return)[[:space:]]' "$tracefs/kprobe_profile"; then
      fail 'probe profile names are already in use'
    fi
    mkdir "$state" || fail 'owned state already exists or cannot be created'
    printf '%s %s\n' "$tid" "$data_fd" > "$state/owner"
    mkdir "$instance"
    printf '0\n' > "$instance/tracing_on"
    printf '256\n' > "$instance/buffer_size_kb"
    printf 'mono\n' > "$instance/trace_clock"
    # Only these fixed kernel arguments are fetched; never dereference data buffers.
    printf 'p:%s/alloc_enter __alloc_skb bytes=$arg1:u64\n' "$group" >> "$tracefs/kprobe_events"
    printf 'r1024:%s/alloc_return __alloc_skb result=$retval:x64\n' "$group" >> "$tracefs/kprobe_events"
    printf 'p:%s/packet_enter virtio_transport_alloc_skb bytes=$arg2:u64\n' "$group" >> "$tracefs/kprobe_events"
    printf 'r1024:%s/packet_return virtio_transport_alloc_skb result=$retval:x64\n' "$group" >> "$tracefs/kprobe_events"
    printf 'p:%s/copy_enter _copy_from_iter bytes=$arg2:u64\n' "$group" >> "$tracefs/kprobe_events"
    printf 'r1024:%s/copy_return _copy_from_iter result=$retval:u64\n' "$group" >> "$tracefs/kprobe_events"
    for event in $events; do
      printf 'common_pid == %s\n' "$tid" > "$instance/events/$group/$event/filter"
      printf '1\n' > "$instance/events/$group/$event/enable"
    done
    for event in sys_enter sys_exit; do
      printf 'common_pid == %s && id == %s\n' "$tid" "$write_syscall" > "$instance/events/raw_syscalls/$event/filter"
      printf '1\n' > "$instance/events/raw_syscalls/$event/enable"
    done
    section setup
    printf 'buffer_size_kb=256\nsamples_limit=180\nsample_interval_seconds=1\n'
    profile
    memory
    printf '1\n' > "$instance/tracing_on"
    # A stopfile and completion marker join this bounded sampler without PID killing.
    nohup /system/bin/sh -c '
      set -eu
      state=$1
      helper=$2
      tid=$3
      data_fd=$4
      trap '\''printf "%s\n" "$?" > "$state/sampler-done"'\'' 0
      : > "$state/sampler-started"
      count=0
      while [ "$count" -lt 180 ] && [ ! -f "$state/sampler-stop" ]; do
        printf "OPENCLAW_KERNEL_SAMPLE\n"
        /system/bin/sh "$helper" memory "$tid" "$data_fd" || exit 1
        count=$((count + 1))
        sleep 1
      done
    ' kernel-memory-sampler "$state" "$0" "$tid" "$data_fd" \
      < /dev/null > "$state/samples" 2> "$state/sampler.private.log" &
    printf '%s\n' "$!" > "$state/sampler-pid"
    remaining=5
    while [ ! -f "$state/sampler-started" ] && [ "$remaining" -gt 0 ]; do
      sleep 1
      remaining=$((remaining - 1))
    done
    [ -f "$state/sampler-started" ] || fail 'memory sampler did not start'
    printf 'OPENCLAW_KERNEL_READY\n'
    ;;
  read)
    require_owner
    trace_snapshot
    ;;
  stop)
    require_owner
    printf '0\n' > "$instance/tracing_on"
    trace_snapshot
    profile
    section stats
    for stats in "$instance"/per_cpu/cpu*/stats; do
      [ -r "$stats" ] || fail 'per-CPU trace statistics are unavailable'
      cpu=${stats%/stats}
      cpu=${cpu##*/cpu}
      printf 'OPENCLAW_KERNEL_CPU %s\n' "$cpu"
      cat "$stats"
    done
    memory
    sampler_failed=0
    stop_sampler || sampler_failed=1
    section samples
    [ ! -f "$state/samples" ] || cat "$state/samples"
    [ "$sampler_failed" -eq 0 ] || fail 'memory sampler did not stop; preserve owned state'
    [ "$(cat "$state/sampler-done")" = 0 ] || fail 'memory sampler failed'
    ;;
  cleanup)
    if [ ! -e "$state" ]; then
      [ ! -d "$instance" ] && [ ! -d "$tracefs/events/$group" ] || fail 'unowned tracing state exists'
      printf 'OPENCLAW_KERNEL_CLEANED\n'
      exit 0
    fi
    require_owner
    cleanup_failed=0
    if [ -d "$instance" ]; then
      printf '0\n' > "$instance/tracing_on" || cleanup_failed=1
      printf '0\n' > "$instance/events/enable" || cleanup_failed=1
      rmdir "$instance" || cleanup_failed=1
    fi
    for event in $events; do
      if [ -d "$tracefs/events/$group/$event" ]; then
        printf -- '-:%s/%s\n' "$group" "$event" >> "$tracefs/kprobe_events" || cleanup_failed=1
      fi
    done
    stop_sampler || cleanup_failed=1
    [ "$cleanup_failed" -eq 0 ] || fail 'cleanup incomplete; preserve owned state'
    rm -r "$state"
    printf 'OPENCLAW_KERNEL_CLEANED\n'
    ;;
esac
