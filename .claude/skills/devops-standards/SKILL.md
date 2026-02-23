---
name: devops-standards
description: |
  Стандарты DevOps и cloud-инфраструктуры: Terraform, Docker, Kubernetes, CI/CD, GitOps.
  Применяется автоматически при: devops, cloud, aws, azure, gcp, terraform, iac,
  infrastructure, kubernetes, k8s, docker, helm, ci/cd, pipeline, deployment,
  argocd, flux, gitops, observability, sli, slo, disaster recovery.
---

# Стандарты DevOps и Cloud Infrastructure

Комплексное руководство по DevOps практикам, Infrastructure as Code и cloud-архитектуре.

## Навигация по документации

| Раздел | Файл | Описание |
|--------|------|----------|
| **Terraform** | [terraform.md](reference/terraform.md) | IaC паттерны, модули, state management |
| **Kubernetes** | [kubernetes.md](reference/kubernetes.md) | Контейнеризация, Helm, StatefulSets |
| **CI/CD** | [cicd.md](reference/cicd.md) | Pipelines, GitOps, ArgoCD, Flux |
| **Security** | [security.md](reference/security.md) | DevSecOps, secrets, policies |
| **Observability** | [observability.md](reference/observability.md) | SLI/SLO, мониторинг, трейсинг |
| **Cloud Platforms** | [cloud_platforms.md](reference/cloud_platforms.md) | AWS, Azure, GCP архитектуры |
| **Templates** | [templates.md](reference/templates.md) | Готовые шаблоны и примеры |

---

## Ключевые принципы DevOps

### Infrastructure as Code (IaC)
- **Version Controlled**: Все изменения в Git
- **Declarative**: Описание желаемого состояния
- **Idempotent**: Повторные запуски дают тот же результат
- **Modular**: Переиспользуемые компоненты
- **Tested**: Автоматическая валидация

### GitOps
- Git как единственный источник истины
- Автоматическая синхронизация с кластером
- Pull-based deployment (ArgoCD, Flux)
- Полный аудит изменений

### Security First
- Least privilege для всех доступов
- Secrets в secret managers (не в коде!)
- Network isolation и zero trust
- Policy as Code (OPA, Sentinel)

---

## Workflow: Реализация инфраструктуры

### 1. Понимание требований
- Бизнес-потребность (новое приложение, миграция, масштабирование)
- Масштаб (трафик, данные, география)
- Ограничения (бюджет, сроки, compliance)

### 2. Проектирование архитектуры
- Выбор cloud platform(s)
- High availability и fault tolerance
- Network topology и security boundaries
- Документация с диаграммами

### 3. Выбор инструментов
| Задача | Инструмент |
|--------|-----------|
| Multi-cloud IaC | Terraform |
| AWS-only | Terraform или CDK |
| Containers | Kubernetes (EKS/GKE/AKS) |
| GitOps | ArgoCD или Flux |
| CI/CD | GitHub Actions, GitLab CI |

### 4. Реализация
- См. [terraform.md](reference/terraform.md) для IaC
- См. [kubernetes.md](reference/kubernetes.md) для K8s
- См. [cicd.md](reference/cicd.md) для pipelines

### 5. Observability
- Определить SLI/SLO (см. [observability.md](reference/observability.md))
- Настроить logging, metrics, tracing
- Создать dashboards и alerts
- Написать runbooks

### 6. Безопасность
- См. [security.md](reference/security.md)
- Secrets management
- Network policies
- RBAC и IAM

---

## Структура проекта IaC

```
infrastructure/
├── terraform/
│   ├── environments/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── production/
│   ├── modules/
│   │   ├── networking/
│   │   ├── compute/
│   │   ├── database/
│   │   └── monitoring/
│   └── README.md
│
├── kubernetes/
│   ├── base/
│   ├── overlays/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── production/
│   └── helm/
│
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
│
├── scripts/
│   ├── deploy.sh
│   └── backup.sh
│
└── docs/
    ├── architecture.md
    └── runbook.md
```

---

## Ключевые паттерны

### Terraform
```hcl
# Remote state с locking
terraform {
  backend "s3" {
    bucket         = "company-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "eu-central-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

# Общие теги
locals {
  common_tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "terraform"
  }
}
```

### Kubernetes Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Zero-downtime
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
      - name: app
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
```

### GitOps с ArgoCD
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source:
    repoURL: https://github.com/org/gitops.git
    targetRevision: main
    path: kubernetes/overlays/production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

---

## Deployment Strategies

| Стратегия | Когда использовать |
|-----------|-------------------|
| **Rolling Update** | Default, постепенная замена pods |
| **Blue/Green** | Мгновенное переключение, быстрый rollback |
| **Canary** | Постепенный rollout с мониторингом метрик |
| **Recreate** | Когда downtime приемлем |

---

## SLI/SLO/SLA

**SLI (Service Level Indicator)**:
- Availability: `successful_requests / total_requests`
- Latency: `p95 response time`
- Error rate: `failed_requests / total_requests`

**SLO (Service Level Objective)**:
- Availability: 99.9% (43 min downtime/month)
- Latency p95: < 200ms
- Error rate: < 0.1%

**SLA**: Бизнес-контракт с последствиями за нарушение SLO.

---

## Disaster Recovery

| Стратегия | RPO | RTO | Стоимость |
|-----------|-----|-----|-----------|
| Backup & Restore | hours | hours | $ |
| Pilot Light | minutes | hours | $$ |
| Warm Standby | seconds | minutes | $$$ |
| Multi-Site Active | none | none | $$$$ |

---

## Checklist перед production

- [ ] Remote state с locking
- [ ] Secrets в secret manager
- [ ] Resource limits установлены
- [ ] Health checks настроены
- [ ] Monitoring и alerting
- [ ] Backups автоматизированы
- [ ] DR план документирован
- [ ] Security scan пройден
- [ ] Network policies настроены
- [ ] RBAC настроен

---

## Примеры и Скрипты

### Готовые примеры

| Пример | Файл | Описание |
|--------|------|----------|
| **Terraform AWS** | [examples/terraform/main.tf](examples/terraform/main.tf) | VPC + ALB + Security Groups |
| **K8s Application** | [examples/kubernetes/complete-app.yaml](examples/kubernetes/complete-app.yaml) | Полный production-ready манифест |
| **GitHub Actions** | [examples/pipelines/github-actions.yml](examples/pipelines/github-actions.yml) | CI/CD pipeline с деплоем |

### Утилиты DevOps

Скрипт [scripts/devops_utils.py](scripts/devops_utils.py) предоставляет CLI для автоматизации:

```bash
# Инициализация Terraform проекта
python scripts/devops_utils.py terraform init-project \
  --name myproject --cloud aws --region us-east-1

# Валидация Kubernetes манифестов
python scripts/devops_utils.py k8s validate --file deployment.yaml

# Генерация Kubernetes deployment
python scripts/devops_utils.py k8s generate \
  --name myapp --image myapp:1.0.0 --namespace production

# Инициализация GitOps структуры
python scripts/devops_utils.py gitops init \
  --tool argocd --environments dev,staging,prod

# Сканирование на секреты
python scripts/devops_utils.py security scan-secrets --directory .
```

---

## Быстрый справочник по задачам

### "Нужно развернуть cloud инфраструктуру"
1. Читай: [reference/terraform.md](reference/terraform.md) → Module templates
2. Смотри: [reference/cloud_platforms.md](reference/cloud_platforms.md) → Architecture patterns
3. Используй: `python scripts/devops_utils.py terraform init-project`

### "Нужно задеплоить контейнерное приложение"
1. Читай: [reference/kubernetes.md](reference/kubernetes.md) → Production-ready deployment
2. Смотри: [examples/kubernetes/complete-app.yaml](examples/kubernetes/complete-app.yaml)
3. Валидируй: `python scripts/devops_utils.py k8s validate --file deployment.yaml`

### "Нужно настроить CI/CD pipeline"
1. Читай: [reference/cicd.md](reference/cicd.md) → Pipeline design patterns
2. Смотри: [examples/pipelines/github-actions.yml](examples/pipelines/github-actions.yml)
3. Настрой: GitOps с ArgoCD или Flux

### "Нужно настроить мониторинг"
1. Читай: [reference/observability.md](reference/observability.md) → SLI/SLO framework
2. Смотри: [reference/templates.md](reference/templates.md) → Prometheus rules
3. Настрой: Dashboards и alerting

### "Нужно обезопасить инфраструктуру"
1. Читай: [reference/security.md](reference/security.md) → DevSecOps practices
2. Сканируй: `python scripts/devops_utils.py security scan-secrets`
3. Внедри: Policy as Code, secrets management

---

## Дополнительные ресурсы

Детальная документация в reference файлах:
- **Terraform паттерны**: [reference/terraform.md](reference/terraform.md)
- **Kubernetes best practices**: [reference/kubernetes.md](reference/kubernetes.md)
- **CI/CD и GitOps**: [reference/cicd.md](reference/cicd.md)
- **DevSecOps**: [reference/security.md](reference/security.md)
- **Observability**: [reference/observability.md](reference/observability.md)
- **Cloud архитектуры**: [reference/cloud_platforms.md](reference/cloud_platforms.md)

---

## Best Practices Summary

### Infrastructure as Code
1. **Version everything** in Git
2. **Use modules** for reusability
3. **Implement state locking** (S3 + DynamoDB)
4. **Never hardcode secrets**
5. **Tag all resources** consistently

### Kubernetes
1. **Set resource limits** on all containers
2. **Implement health checks** (liveness, readiness)
3. **Use namespaces** for isolation
4. **Enable RBAC** and network policies
5. **Run as non-root** user

### CI/CD
1. **Automate everything** possible
2. **Test before deploy** (lint, security scan, unit tests)
3. **Use GitOps** for declarative deployments
4. **Implement rollback** strategies
5. **Monitor deployments** closely

### Security
1. **Least privilege** access
2. **Encrypt data** at rest and in transit
3. **Scan for vulnerabilities** regularly
4. **Rotate secrets** automatically
5. **Audit all changes**
