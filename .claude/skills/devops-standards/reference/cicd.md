# CI/CD Pipelines & GitOps

## CI/CD Pipeline Stages

### 1. Source → 2. Build → 3. Test → 4. Deploy → 5. Monitor

```
┌──────────┐   ┌───────┐   ┌──────┐   ┌────────┐   ┌─────────┐
│  Source  │──▶│ Build │──▶│ Test │──▶│ Deploy │──▶│ Monitor │
│   (Git)  │   │       │   │      │   │        │   │         │
└──────────┘   └───────┘   └──────┘   └────────┘   └─────────┘
```

## GitOps Principles

### Core Concepts
1. **Git as Single Source of Truth**: All configuration in Git
2. **Declarative**: Desired state defined, not imperative steps
3. **Automated**: Continuous reconciliation of desired vs actual state
4. **Auditable**: All changes tracked in Git history

### GitOps Workflow
```
Developer ──▶ Git Push ──▶ GitOps Controller ──▶ Kubernetes Cluster
                             (ArgoCD/Flux)
                                  │
                                  ▼
                            Continuous Sync
```

## ArgoCD Setup

### Installation
```bash
# Install ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Access ArgoCD UI
kubectl port-forward svc/argocd-server -n argocd 8080:443

# Get initial password
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

### ArgoCD Application
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-production
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default

  source:
    repoURL: https://github.com/myorg/myapp-gitops.git
    targetRevision: main
    path: kubernetes/overlays/production

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: true      # Delete resources not in Git
      selfHeal: true   # Sync if cluster state drifts
      allowEmpty: false

    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true

    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas  # Ignore HPA-managed replicas
```

### ArgoCD ApplicationSet (Multi-Environment)
```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - env: dev
        cluster: https://kubernetes.default.svc
      - env: staging
        cluster: https://kubernetes.default.svc
      - env: production
        cluster: https://prod-cluster-api.example.com

  template:
    metadata:
      name: 'myapp-{{env}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/myapp-gitops.git
        targetRevision: main
        path: 'kubernetes/overlays/{{env}}'
      destination:
        server: '{{cluster}}'
        namespace: '{{env}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Flux CD Setup

### Installation
```bash
# Install Flux CLI
brew install fluxcd/tap/flux

# Check prerequisites
flux check --pre

# Bootstrap Flux
flux bootstrap github \
  --owner=myorg \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --personal
```

### Flux GitRepository
```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: myapp
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/myorg/myapp-gitops
  ref:
    branch: main
  secretRef:
    name: git-credentials
```

### Flux Kustomization
```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: myapp-production
  namespace: flux-system
spec:
  interval: 5m
  path: ./kubernetes/overlays/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: myapp
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: myapp
      namespace: production
  timeout: 2m
```

## Progressive Delivery

### Canary Deployment with Flagger
```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 80
    targetPort: 8080

  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10

    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99
      interval: 1m

    - name: request-duration
      thresholdRange:
        max: 500
      interval: 1m

    webhooks:
    - name: load-test
      url: http://flagger-loadtester/
      timeout: 5s
      metadata:
        cmd: "hey -z 1m -q 10 -c 2 http://myapp-canary.production/"

    - name: smoke-test
      url: http://flagger-loadtester/
      timeout: 5s
      metadata:
        type: smoke
        cmd: "curl -s http://myapp-canary.production/healthz | grep ok"
```

### Blue/Green Deployment
```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp
  namespace: production
spec:
  selector:
    app: myapp
    version: blue  # Switch to 'green' for deployment
  ports:
  - port: 80
    targetPort: 8080

---
# Blue Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-blue
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: blue
  template:
    metadata:
      labels:
        app: myapp
        version: blue
    spec:
      containers:
      - name: myapp
        image: myapp:v1.0.0

---
# Green Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-green
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: green
  template:
    metadata:
      labels:
        app: myapp
        version: green
    spec:
      containers:
      - name: myapp
        image: myapp:v2.0.0
```

## CI/CD Pipeline Examples

### GitHub Actions - Complete Pipeline
See [templates.md](templates.md) for full GitHub Actions pipeline

---

## SourceCraft CI/CD

### Обзор

[SourceCraft](https://sourcecraft.dev) — CI/CD платформа от Яндекс с интегрированным Container Registry.

**Особенности:**
- Нативная поддержка Docker на worker'е
- Интегрированный Container Registry (`pkg.sourcecraft.tech`)
- Предопределённые переменные для автоматизации
- Простая YAML конфигурация

### Структура конфигурации

Файл `.sourcecraft/ci.yaml` в корне репозитория:

```yaml
on:
  push:
    - workflows: [build]
      filter:
        branches: [main]

workflows:
  build:
    tasks:
      - name: build-and-push
        env:
          MY_VAR: value
        cubes:
          - name: step-1
            script:
              - echo "Hello"
```

### Типы Cubes (кубиков)

#### Нативные cubes (рекомендуется для Docker)
Выполняются на worker'е напрямую. Docker доступен без настройки.

```yaml
cubes:
  - name: docker-build
    script:
      - docker build . -t myapp:latest
```

#### Docker cubes
Выполняются внутри контейнера. Только `/sourcecraft` сохраняется между cubes.

```yaml
cubes:
  - name: go-build
    image: golang:1.23
    script:
      - go build ./...
```

### Предопределённые переменные

| Переменная | Описание |
|------------|----------|
| `SOURCECRAFT_TOKEN` | Токен для API и Container Registry |
| `SOURCECRAFT_COMMIT_SHORT_SHA` | Короткий хеш коммита (8 символов) |
| `SOURCECRAFT_COMMIT_SHA` | Полный хеш коммита |
| `SOURCECRAFT_COMMIT_REF_NAME` | Имя ветки/тега |
| `SOURCECRAFT_WORKSPACE` | Путь к репозиторию |

### Container Registry

**URL формат:**
```
pkg.sourcecraft.tech/cr/<org_slug>/<registry_id>/<image>:<tag>
```

**Аутентификация в CI:**
```yaml
script:
  - echo "$SOURCECRAFT_TOKEN" | docker login pkg.sourcecraft.tech --username iam --password-stdin
```

**Локальная аутентификация (PAT):**
```bash
echo <PAT> | docker login pkg.sourcecraft.tech --username iam --password-stdin
```

### Секреты

Создаются в UI: Repository → Settings → Secrets

```yaml
env:
  MY_SECRET: ${{ secrets.MY_SECRET_NAME }}
```

### Ограничения SourceCraft

| Инструмент | Статус | Причина |
|------------|--------|---------|
| **Docker (native cube)** | ✅ Работает | Docker на worker'е |
| **ko** | ❌ Не работает | 500 Internal Server Error |
| **Kaniko** | ❌ Не работает | 500 Internal Server Error |
| **Buildah** | ❌ Не работает | Требует CLONE_NEWUSER |
| **Docker-in-Docker** | ❌ Не работает | Сервис docker недоступен |

**Решение:** Всегда используй нативные cubes с docker на worker'е.

### Полный Pipeline Пример

```yaml
on:
  push:
    - workflows: [build]
      filter:
        branches: [main]

workflows:
  build:
    tasks:
      - name: build-and-push
        env:
          REGISTRY: pkg.sourcecraft.tech/cr/myorg/registry-id
          IMAGE_NAME: myapp
        cubes:
          - name: docker-login
            script:
              - echo "$SOURCECRAFT_TOKEN" | docker login pkg.sourcecraft.tech --username iam --password-stdin

          - name: docker-build
            script:
              - docker build . --tag $REGISTRY/$IMAGE_NAME:$SOURCECRAFT_COMMIT_SHORT_SHA --tag $REGISTRY/$IMAGE_NAME:latest

          - name: docker-push
            script:
              - docker push $REGISTRY/$IMAGE_NAME:$SOURCECRAFT_COMMIT_SHORT_SHA
              - docker push $REGISTRY/$IMAGE_NAME:latest
```

### Multi-Service Image

Один образ может содержать несколько бинарников:

```yaml
# В Kubernetes Deployment указывается command:
spec:
  containers:
    - name: provider
      image: pkg.sourcecraft.tech/cr/myorg/registry/app:latest
      command: ["/app/provider"]
    - name: collector
      image: pkg.sourcecraft.tech/cr/myorg/registry/app:latest
      command: ["/app/collector"]
```

### Документация SourceCraft

- [CI/CD Reference](https://sourcecraft.dev/portal/docs/ru/sourcecraft/ci-cd-ref/)
- [Cubes](https://sourcecraft.dev/portal/docs/ru/sourcecraft/ci-cd-ref/cubes)
- [Predefined Variables](https://sourcecraft.dev/portal/docs/ru/sourcecraft/ci-cd-ref/predefined-variables)
- [Configure Docker](https://sourcecraft.dev/portal/docs/ru/sourcecraft/operations/configure-docker)

---

### GitLab CI Pipeline
```yaml
variables:
  DOCKER_DRIVER: overlay2
  DOCKER_TLS_CERTDIR: "/certs"
  IMAGE_TAG: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA

stages:
  - lint
  - build
  - test
  - security
  - deploy

# Lint stage
lint:code:
  stage: lint
  image: node:20-alpine
  script:
    - npm ci
    - npm run lint
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

lint:dockerfile:
  stage: lint
  image: hadolint/hadolint:latest-alpine
  script:
    - hadolint Dockerfile

# Build stage
build:image:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - docker build --cache-from $CI_REGISTRY_IMAGE:latest -t $IMAGE_TAG .
    - docker tag $IMAGE_TAG $CI_REGISTRY_IMAGE:latest
    - docker push $IMAGE_TAG
    - docker push $CI_REGISTRY_IMAGE:latest
  only:
    - main
    - develop

# Test stage
test:unit:
  stage: test
  image: node:20-alpine
  script:
    - npm ci
    - npm run test:unit
  coverage: '/Statements\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml

test:integration:
  stage: test
  image: $IMAGE_TAG
  services:
    - postgres:15-alpine
  variables:
    POSTGRES_DB: testdb
    POSTGRES_USER: testuser
    POSTGRES_PASSWORD: testpass
  script:
    - npm run test:integration

# Security stage
security:trivy:
  stage: security
  image: aquasec/trivy:latest
  script:
    - trivy image --exit-code 1 --severity HIGH,CRITICAL $IMAGE_TAG
  allow_failure: true

security:secrets:
  stage: security
  image: trufflesecurity/trufflehog:latest
  script:
    - trufflehog filesystem . --fail

# Deploy stage
deploy:dev:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context dev-cluster
    - kubectl set image deployment/myapp myapp=$IMAGE_TAG -n development
    - kubectl rollout status deployment/myapp -n development
  environment:
    name: development
  only:
    - develop

deploy:staging:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context staging-cluster
    - kubectl set image deployment/myapp myapp=$IMAGE_TAG -n staging
    - kubectl rollout status deployment/myapp -n staging
  environment:
    name: staging
  only:
    - main

deploy:production:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context prod-cluster
    - kubectl set image deployment/myapp myapp=$IMAGE_TAG -n production
    - kubectl rollout status deployment/myapp -n production
  environment:
    name: production
  when: manual
  only:
    - main
```

### Jenkins Pipeline (Jenkinsfile)
```groovy
pipeline {
    agent any

    environment {
        DOCKER_REGISTRY = 'ghcr.io'
        IMAGE_NAME = 'myorg/myapp'
        IMAGE_TAG = "${env.GIT_COMMIT.take(7)}"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Lint') {
            parallel {
                stage('Lint Code') {
                    steps {
                        sh 'npm ci'
                        sh 'npm run lint'
                    }
                }
                stage('Lint Dockerfile') {
                    steps {
                        sh 'hadolint Dockerfile'
                    }
                }
            }
        }

        stage('Build') {
            steps {
                script {
                    docker.withRegistry("https://${DOCKER_REGISTRY}", 'docker-credentials') {
                        def app = docker.build("${IMAGE_NAME}:${IMAGE_TAG}")
                        app.push()
                        app.push('latest')
                    }
                }
            }
        }

        stage('Test') {
            parallel {
                stage('Unit Tests') {
                    steps {
                        sh 'npm run test:unit'
                    }
                }
                stage('Integration Tests') {
                    steps {
                        sh 'npm run test:integration'
                    }
                }
            }
        }

        stage('Security Scan') {
            steps {
                sh "trivy image --exit-code 1 --severity HIGH,CRITICAL ${IMAGE_NAME}:${IMAGE_TAG}"
            }
        }

        stage('Deploy to Dev') {
            when {
                branch 'develop'
            }
            steps {
                kubernetesDeploy(
                    configs: 'kubernetes/overlays/dev',
                    kubeconfigId: 'dev-kubeconfig'
                )
            }
        }

        stage('Deploy to Production') {
            when {
                branch 'main'
            }
            steps {
                input message: 'Deploy to production?', ok: 'Deploy'
                kubernetesDeploy(
                    configs: 'kubernetes/overlays/prod',
                    kubeconfigId: 'prod-kubeconfig'
                )
            }
        }
    }

    post {
        success {
            slackSend(
                color: 'good',
                message: "✅ Build ${env.BUILD_NUMBER} succeeded: ${env.JOB_NAME}"
            )
        }
        failure {
            slackSend(
                color: 'danger',
                message: "❌ Build ${env.BUILD_NUMBER} failed: ${env.JOB_NAME}"
            )
        }
    }
}
```

## Infrastructure Testing

### Terratest (Go)
```go
package test

import (
    "testing"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
)

func TestTerraformVPCModule(t *testing.T) {
    t.Parallel()

    terraformOptions := terraform.WithDefaultRetryableErrors(t, &terraform.Options{
        TerraformDir: "../modules/vpc",
        Vars: map[string]interface{}{
            "name_prefix":   "test",
            "vpc_cidr":      "10.0.0.0/16",
        },
    })

    defer terraform.Destroy(t, terraformOptions)

    terraform.InitAndApply(t, terraformOptions)

    vpcID := terraform.Output(t, terraformOptions, "vpc_id")
    assert.NotEmpty(t, vpcID)
}
```

### Checkov (Infrastructure Security)
```bash
# Scan Terraform
checkov -d terraform/ --framework terraform

# Scan Kubernetes
checkov -d kubernetes/ --framework kubernetes

# Output JSON
checkov -d terraform/ --framework terraform -o json > results.json

# Skip specific checks
checkov -d terraform/ --skip-check CKV_AWS_23
```

### Kitchen-Terraform
```ruby
# kitchen.yml
driver:
  name: terraform

provisioner:
  name: terraform

verifier:
  name: terraform
  systems:
    - name: default
      backend: aws
      controls:
        - vpc_test

platforms:
  - name: aws

suites:
  - name: default
    driver:
      variables:
        region: us-east-1
```

## Deployment Strategies

### Rolling Update (Default in Kubernetes)
```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # Max pods above desired during update
      maxUnavailable: 0  # Zero-downtime deployment
```

### Recreate (Downtime Acceptable)
```yaml
spec:
  strategy:
    type: Recreate  # Kill all pods, then create new ones
```

### Canary (Gradual Rollout)
- Deploy new version alongside old
- Route small % of traffic to new version
- Monitor metrics
- Gradually increase traffic
- Rollback if issues detected

### Blue/Green (Instant Switch)
- Deploy new version (green) alongside old (blue)
- Test green environment
- Switch traffic from blue to green
- Keep blue for quick rollback

## Rollback Procedures

### Kubernetes Rollback
```bash
# View rollout history
kubectl rollout history deployment/myapp -n production

# Rollback to previous version
kubectl rollout undo deployment/myapp -n production

# Rollback to specific revision
kubectl rollout undo deployment/myapp -n production --to-revision=3

# Check rollout status
kubectl rollout status deployment/myapp -n production
```

### ArgoCD Rollback
```bash
# Rollback application
argocd app rollback myapp-production

# Rollback to specific revision
argocd app rollback myapp-production 123
```

## CI/CD Best Practices

1. **Automate Everything**: From code commit to production
2. **Fast Feedback**: Fail fast, fix fast
3. **Test in Production-like**: Staging mirrors production
4. **Gradual Rollout**: Canary or blue/green for production
5. **Easy Rollback**: One-click rollback capability
6. **Security Scanning**: Every stage, every pipeline
7. **Infrastructure as Code**: No manual changes
8. **GitOps**: Git as single source of truth
9. **Observability**: Monitor every deployment
10. **Post-Deployment Tests**: Smoke tests after deploy

---

## Pipeline Performance Optimization

- **Caching**: Cache dependencies between runs
- **Parallel Execution**: Run independent stages in parallel
- **Docker Layer Caching**: Use BuildKit and layer caching
- **Artifacts**: Share build artifacts between stages
- **Resource Limits**: Optimize CI runner resources
- **Skip Unnecessary**: Only run tests for changed code
