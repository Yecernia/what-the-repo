#!/usr/bin/env bash
set -Eeuo pipefail

# This smoke test validates a real k3d/k3s control plane and service path.
# It intentionally deploys an isolated test workload instead of production images.
script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
script_dir="$(cd -- "$script_dir" && pwd)"
root="$(cd -- "$script_dir/.." && pwd)"
cluster_name="${K3D_CLUSTER_NAME:-wtr-ci}"
namespace="${K3D_SMOKE_NAMESPACE:-wtr-ci}"
product_namespace="what-the-repo"
service_name="wtr-k3d-smoke"
image="${K3D_SMOKE_IMAGE:-nginx:1.27-alpine}"
k3s_image="${K3D_K3S_IMAGE:-docker.io/rancher/k3s:v1.36.3-k3s1}"
local_port="${K3D_SMOKE_PORT:-18080}"
create_cluster="${K3D_SMOKE_CREATE_CLUSTER:-1}"
delete_cluster="${K3D_SMOKE_DELETE_CLUSTER:-$create_cluster}"
port_forward_pid=""
port_forward_log=""

cleanup() {
  local status=$?

  if [[ -n "$port_forward_pid" ]] && kill -0 "$port_forward_pid" 2>/dev/null; then
    kill "$port_forward_pid" 2>/dev/null || true
    wait "$port_forward_pid" 2>/dev/null || true
  fi
  if [[ -n "$port_forward_log" ]]; then
    rm -f -- "$port_forward_log"
  fi

  if [[ "$delete_cluster" == "1" ]] && command -v k3d >/dev/null 2>&1; then
    k3d cluster delete "$cluster_name" >/dev/null 2>&1 || true
  fi

  exit "$status"
}
trap cleanup EXIT

for command_name in kubectl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    exit 127
  fi
done
port_forward_log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wtr-k3d-smoke-$$.log"

if [[ "$create_cluster" == "1" ]]; then
  if ! command -v k3d >/dev/null 2>&1; then
    echo "missing required command: k3d" >&2
    exit 127
  fi
  k3d cluster create "$cluster_name" \
    --agents 0 \
    --no-lb \
    --wait \
    --timeout 120s \
    --image "$k3s_image" \
    --k3s-arg '--disable=traefik@server:*' \
    --k3s-arg '--disable=servicelb@server:*' \
    --k3s-arg '--disable=metrics-server@server:*'
fi

kubectl config use-context "k3d-$cluster_name" >/dev/null
kubectl wait --for=condition=Ready node --all --timeout=120s

for target_namespace in "$product_namespace" "$namespace"; do
  kubectl create namespace "$target_namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
done

kubectl apply --dry-run=server \
  -f "$root/infra/k8s/10-storage.yaml" \
  -f "$root/infra/k8s/20-postgres.yaml" \
  -f "$root/infra/k8s/30-redis.yaml" \
  -f "$root/infra/k8s/40-migration.yaml" \
  -f "$root/infra/k8s/50-application.yaml" \
  -f "$root/infra/k8s/55-evolution.yaml" \
  -f "$root/infra/k8s/60-postgres-backup.yaml" \
  -f "$root/infra/k8s/70-compose-restore.yaml" \
  >/dev/null
echo "k3s manifests accepted by the k3d API server (server-side dry-run)"

kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $service_name
  namespace: $namespace
  labels:
    app.kubernetes.io/name: $service_name
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: $service_name
  template:
    metadata:
      labels:
        app.kubernetes.io/name: $service_name
    spec:
      automountServiceAccountToken: false
      containers:
        - name: nginx
          image: $image
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: http
            periodSeconds: 2
            timeoutSeconds: 2
            failureThreshold: 15
---
apiVersion: v1
kind: Service
metadata:
  name: $service_name
  namespace: $namespace
spec:
  selector:
    app.kubernetes.io/name: $service_name
  ports:
    - name: http
      port: 80
      targetPort: http
YAML

kubectl rollout status "deployment/$service_name" -n "$namespace" --timeout=120s
kubectl get nodes -o wide
kubectl get pods,service -n "$namespace" -o wide

kubectl port-forward -n "$namespace" "service/$service_name" "$local_port:80" >"$port_forward_log" 2>&1 &
port_forward_pid=$!

for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl --fail --silent --show-error "http://127.0.0.1:$local_port/" >/dev/null; then
    echo "k3d smoke passed: cluster=$cluster_name workload=$namespace/$service_name"
    exit 0
  fi
  sleep 1
done

echo "k3d smoke failed: service did not respond on 127.0.0.1:$local_port" >&2
cat "$port_forward_log" >&2
exit 1
