{{/* Common labels; `component` names the compose service a resource came from. */}}
{{- define "foundry.labels" -}}
app.kubernetes.io/part-of: foundry
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "foundry.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* One env entry per listed key of the app Secret. Optional: a key absent from .env stays absent. */}}
{{- define "foundry.secretEnv" -}}
{{- $secret := .root.Values.secretName -}}
{{- range .keys }}
- name: {{ . }}
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: {{ . }}, optional: true }
{{- end }}
{{- end -}}

{{/* An env entry read from the database Secret. */}}
{{- define "foundry.dbEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef: { name: {{ .root.Values.database.secretName }}, key: {{ .key | default .name }} }
{{- end -}}

{{/* The database CA, when one is set: env + mount for any container that dials Postgres. Node's pg treats
sslmode=require as verify-full, so a private CA must be trusted or every connection fails. */}}
{{- define "foundry.dbCaEnv" -}}
{{- if .Values.database.caConfigMap }}
- { name: NODE_EXTRA_CA_CERTS, value: /etc/foundry-db-ca/ca.crt }
- { name: PGSSLROOTCERT, value: /etc/foundry-db-ca/ca.crt }
{{- end }}
{{- end -}}

{{- define "foundry.dbCaMount" -}}
{{- if .Values.database.caConfigMap }}
- { name: db-ca, mountPath: /etc/foundry-db-ca, readOnly: true }
{{- end }}
{{- end -}}

{{- define "foundry.dbCaVolume" -}}
{{- with .Values.database.caConfigMap }}
- name: db-ca
  configMap: { name: {{ . }} }
{{- end }}
{{- end -}}

{{/* Wait until Postgres answers. ADMIN_DSN works for an in-cluster and an external server alike. */}}
{{- define "foundry.waitForDb" -}}
- name: wait-for-db
  image: {{ .Values.images.postgres }}
  imagePullPolicy: {{ .Values.pullPolicy }}
  command: ["sh", "-c", "until pg_isready -d \"$ADMIN_DSN\" -q; do echo waiting for postgres; sleep 2; done"]
  env:
    {{- include "foundry.dbEnv" (dict "root" . "name" "ADMIN_DSN") | nindent 4 }}
    {{- include "foundry.dbCaEnv" . | nindent 4 }}
  volumeMounts:
    {{- include "foundry.dbCaMount" . | nindent 4 }}
{{- end -}}

{{/* The sandbox pods' security context, mirroring compose's cap_drop/cap_add/no-new-privileges. */}}
{{- define "foundry.sandboxSecurity" -}}
allowPrivilegeEscalation: false
runAsUser: 0
capabilities:
  drop: ["ALL"]
  add: {{ toJson .caps }}
{{- if .appArmor }}
appArmorProfile:
  type: {{ .appArmor }}
{{- end }}
{{- end -}}

{{/* NetworkPolicy pieces: DNS egress, and a peer selected by component. */}}
{{- define "foundry.np.dns" -}}
- to:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .dnsNamespace }} } }
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- end -}}

{{- define "foundry.np.from" -}}
- podSelector:
    matchLabels: {{- include "foundry.selector" . | nindent 6 }}
{{- end -}}
