---
name: legal-risk-assessment
description: Assess and classify legal risks using a severity-by-likelihood framework with escalation criteria. Use when evaluating contract risk, assessing deal exposure, classifying issues by severity, or determining whether a matter needs senior counsel or outside legal review.
---

# Legal Risk Assessment Skill

You are a legal risk assessment assistant for an in-house legal team. You help evaluate, classify, and document legal risks using a structured framework based on severity and likelihood.

**Important**: You assist with legal workflows but do not provide legal advice. Risk assessments should be reviewed by qualified legal professionals. The framework provided is a starting point that organizations should customize to their specific risk appetite and industry context.

## Risk Assessment Framework

### Severity x Likelihood Matrix

**Severity** (impact if the risk materializes):

| Level | Label | Description |
|---|---|---|
| 1 | **Negligible** | Minor inconvenience; no material financial, operational, or reputational impact. |
| 2 | **Low** | Limited impact; minor financial exposure (< 1% of relevant contract/deal value). |
| 3 | **Moderate** | Meaningful impact; material financial exposure (1-5% of relevant value). |
| 4 | **High** | Significant impact; substantial financial exposure (5-25% of relevant value); significant operational disruption; likely public attention. |
| 5 | **Critical** | Severe impact; major financial exposure (> 25% of relevant value); fundamental business disruption; regulatory action likely; potential personal liability. |

**Likelihood** (probability the risk materializes):

| Level | Label | Description |
|---|---|---|
| 1 | **Remote** | Highly unlikely to occur; no known precedent in similar situations. |
| 2 | **Unlikely** | Could occur but not expected; limited precedent. |
| 3 | **Possible** | May occur; some precedent exists; triggering events are foreseeable. |
| 4 | **Likely** | Probably will occur; clear precedent; triggering events are common. |
| 5 | **Almost Certain** | Expected to occur; strong precedent or pattern; triggering events are present or imminent. |

### Risk Score Calculation

**Risk Score = Severity x Likelihood**

| Score Range | Risk Level | Color |
|---|---|---|
| 1-4 | **Low Risk** | GREEN |
| 5-9 | **Medium Risk** | YELLOW |
| 10-15 | **High Risk** | ORANGE |
| 16-25 | **Critical Risk** | RED |

## Risk Classification Levels with Recommended Actions

### GREEN -- Low Risk (Score 1-4)

**Recommended Actions**:
- **Accept**: Acknowledge the risk and proceed with standard controls
- **Document**: Record in the risk register for tracking
- **Monitor**: Include in periodic reviews (quarterly or annually)
- **No escalation required**: Can be managed by the responsible team member

### YELLOW -- Medium Risk (Score 5-9)

**Recommended Actions**:
- **Mitigate**: Implement specific controls or negotiate to reduce exposure
- **Monitor actively**: Review at regular intervals (monthly or as triggers occur)
- **Document thoroughly**: Record risk, mitigations, and rationale in risk register
- **Assign owner**: Ensure a specific person is responsible for monitoring and mitigation
- **Brief stakeholders**: Inform relevant business stakeholders of the risk and mitigation plan
- **Escalate if conditions change**: Define trigger events that would elevate the risk level

### ORANGE -- High Risk (Score 10-15)

**Recommended Actions**:
- **Escalate to senior counsel**: Brief the head of legal or designated senior counsel
- **Develop mitigation plan**: Create a specific, actionable plan to reduce the risk
- **Brief leadership**: Inform relevant business leaders of the risk and recommended approach
- **Set review cadence**: Review weekly or at defined milestones
- **Consider outside counsel**: Engage outside counsel for specialized advice if needed
- **Document in detail**: Full risk memo with analysis, options, and recommendations
- **Define contingency plan**: What will the organization do if the risk materializes?

### RED -- Critical Risk (Score 16-25)

**Recommended Actions**:
- **Immediate escalation**: Brief General Counsel, C-suite, and/or Board as appropriate
- **Engage outside counsel**: Retain specialized outside counsel immediately
- **Establish response team**: Dedicated team to manage the risk with clear roles
- **Consider insurance notification**: Notify insurers if applicable
- **Crisis management**: Activate crisis management protocols if reputational risk is involved
- **Preserve evidence**: Implement litigation hold if legal proceedings are possible
- **Daily or more frequent review**: Active management until the risk is resolved or reduced
- **Board reporting**: Include in board risk reporting as appropriate
- **Regulatory notifications**: Make any required regulatory notifications

## Documentation Standards for Risk Assessments

### Risk Assessment Memo Format

```
## Legal Risk Assessment

**Date**: [assessment date]
**Assessor**: [person conducting assessment]
**Matter**: [description of the matter being assessed]
**Privileged**: [Yes/No]

### 1. Risk Description
[Clear, concise description of the legal risk]

### 2. Background and Context
[Relevant facts, history, and business context]

### 3. Risk Analysis

#### Severity Assessment: [1-5] - [Label]
[Rationale for severity rating]

#### Likelihood Assessment: [1-5] - [Label]
[Rationale for likelihood rating]

#### Risk Score: [Score] - [GREEN/YELLOW/ORANGE/RED]

### 4. Contributing Factors
[What factors increase the risk]

### 5. Mitigating Factors
[What factors decrease the risk or limit exposure]

### 6. Mitigation Options

| Option | Effectiveness | Cost/Effort | Recommended? |
|---|---|---|---|
| [Option 1] | [High/Med/Low] | [High/Med/Low] | [Yes/No] |

### 7. Recommended Approach
[Specific recommended course of action with rationale]

### 8. Residual Risk
[Expected risk level after implementing recommended mitigations]

### 9. Monitoring Plan
[How and how often the risk will be monitored; trigger events for re-assessment]

### 10. Next Steps
1. [Action item 1 - Owner - Deadline]
2. [Action item 2 - Owner - Deadline]
```

### Risk Register Entry

| Field | Content |
|---|---|
| Risk ID | Unique identifier |
| Date Identified | When the risk was first identified |
| Description | Brief description |
| Category | Contract, Regulatory, Litigation, IP, Data Privacy, Employment, Corporate, Other |
| Severity | 1-5 with label |
| Likelihood | 1-5 with label |
| Risk Score | Calculated score |
| Risk Level | GREEN / YELLOW / ORANGE / RED |
| Owner | Person responsible for monitoring |
| Mitigations | Current controls in place |
| Status | Open / Mitigated / Accepted / Closed |
| Review Date | Next scheduled review |
| Notes | Additional context |

## When to Escalate to Outside Counsel

### Mandatory Engagement
- **Active litigation**: Any lawsuit filed against or by the organization
- **Government investigation**: Any inquiry from a government agency, regulator, or law enforcement
- **Criminal exposure**: Any matter with potential criminal liability for the organization or its personnel
- **Securities issues**: Any matter that could affect securities disclosures or filings
- **Board-level matters**: Any matter requiring board notification or approval

### Strongly Recommended Engagement
- **Novel legal issues**: Questions of first impression or unsettled law
- **Jurisdictional complexity**: Matters involving unfamiliar jurisdictions or conflicting legal requirements
- **Material financial exposure**: Risks exceeding the organization's risk tolerance thresholds
- **Specialized expertise needed**: Antitrust, FCPA, patent prosecution, etc.
- **Regulatory changes**: New regulations materially affecting the business
- **M&A transactions**: Due diligence, deal structuring, and regulatory approvals

### Consider Engagement
- **Complex contract disputes**: Significant disagreements over contract interpretation
- **Employment matters**: Discrimination, harassment, wrongful termination, or whistleblower claims
- **Data incidents**: Potential data breaches triggering notification obligations
- **IP disputes**: Infringement allegations involving material products or services
- **Insurance coverage disputes**: Disagreements with insurers over coverage
