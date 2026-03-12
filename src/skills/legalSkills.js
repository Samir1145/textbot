import contractReview from './contract-review.md?raw'
import ndaTriage from './nda-triage.md?raw'
import legalRiskAssessment from './legal-risk-assessment.md?raw'
import compliance from './compliance.md?raw'
import cannedResponses from './canned-responses.md?raw'
import meetingBriefing from './meeting-briefing.md?raw'

export const LEGAL_SKILLS = [
  {
    id: 'contract-review',
    name: 'Contract Review',
    systemPrompt: contractReview,
  },
  {
    id: 'nda-triage',
    name: 'NDA Triage',
    systemPrompt: ndaTriage,
  },
  {
    id: 'legal-risk-assessment',
    name: 'Legal Risk Assessment',
    systemPrompt: legalRiskAssessment,
  },
  {
    id: 'compliance',
    name: 'Compliance Review',
    systemPrompt: compliance,
  },
  {
    id: 'canned-responses',
    name: 'Canned Responses',
    systemPrompt: cannedResponses,
  },
  {
    id: 'meeting-briefing',
    name: 'Meeting Briefing',
    systemPrompt: meetingBriefing,
  },
]
