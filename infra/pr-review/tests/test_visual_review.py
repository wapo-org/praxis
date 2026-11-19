from pathlib import Path
import stat

from diff_index import DiffIndex
from review import build_review
from visual_review import CONTACT_SHEET, PNG_SIGNATURE, parse_visual, retain_capture


def test_visual_score_and_issues_are_separate_notes_with_private_media_reference() -> None:
    payload = {'score': 7, 'inconsistencies': [{'view': 'Mobile', 'issue': 'The header clips @user https://example.com/token.'}]}
    visual = parse_visual(payload, recording_retained=True)
    review = build_review(gates=[], findings=[], hands_on=None, diff=DiffIndex(files={}), visual=visual, run_id='abcdef012345')
    assert review['body'] == '' and not review['comments']
    assert len(review['notes']) == 3
    assert '7/10' in review['notes'][0]
    assert 'header clips' in review['notes'][1] and '@user' not in review['notes'][1] and 'https://' not in review['notes'][1]
    assert '`abcdef012345`' in review['notes'][2]


def test_invalid_visual_scores_are_rejected_and_access_requests_only_name_scope() -> None:
    assert parse_visual({'score': True, 'inconsistencies': []}, recording_retained=False) is None
    assert parse_visual({'score': 11, 'inconsistencies': []}, recording_retained=False) is None
    hands_on = {'access_blocker': 'development_preview', 'manual_observations': 'password=secret'}
    review = build_review(gates=[], findings=[], hands_on=hands_on, diff=DiffIndex(files={}))
    assert len(review['notes']) == 1 and 'preview' in review['notes'][0] and 'secret' not in str(review)


def test_media_is_retained_with_private_modes(tmp_path: Path) -> None:
    target = tmp_path / 'abcdef012345'
    retain_capture(target, CONTACT_SHEET, PNG_SIGNATURE)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700
    assert stat.S_IMODE((target / CONTACT_SHEET).stat().st_mode) == 0o600
