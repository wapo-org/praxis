# Verification evidence (C-tests)

Worktree: `/Users/artemchmylenko/.t3/worktrees/wapo-ios-app/t3-69a0bc41`.
Branch: `cloud/ios-tests`. Private simulator: `Cloud-C-tests`,
`3A735EA8-8319-4B13-BB7A-457C90A06B2B` (iPhone 17 Pro, iOS 26.5).
Derived data: `/tmp/praxis-cloud-dd/C-tests`.

## Harness

Command prefix for every run:

```sh
~/.praxis-agent-state/cloud/tools/slot.sh C-tests xcodebuild \
  -project PraxisChat/PraxisChat.xcodeproj -scheme PraxisChat \
  -destination 'platform=iOS Simulator,id=3A735EA8-8319-4B13-BB7A-457C90A06B2B' \
  -parallel-testing-enabled NO -derivedDataPath /tmp/praxis-cloud-dd/C-tests
```

- `-only-testing:PraxisChatTests/CloudTestBackendTests test`, result bundle
  `/tmp/praxis-cloud-dd/C-tests-harness-serial.xcresult`: **16 passed, 0 failed,
  0 skipped**, 0.708 seconds of test execution (first revision).
- Expanded harness, same selection plus
  `-only-testing:PraxisChatUITests/ComposerClearUITests`
  `-only-testing:PraxisChatUITests/PlusTrayUITests`, bundle
  `/tmp/praxis-cloud-dd/C-tests-harness-baseline.xcresult`: **18 harness tests
  passed, 0 failed, 0 skipped**, 0.477 seconds. The UI portion is still running
  at this checkpoint.

The initial baseline command used default parallelism; Xcode made four clones
and could not launch their UI runner (`FBSOpenApplicationServiceErrorDomain`).
It was stopped with no test result claimed. A first harness compilation found
and fixed a Swift 6 sending-closure test capture. Serial testing on the explicit
private simulator works after first boot completed.

## Acceptance status

Ten `CloudUITests` compile with the harness. Their end-to-end execution awaits
C-net, C-screens and Lead C's production construction hooks; they are not
skipped. Cloud screenshots will come from those runs, not from the demo or an
unconnected mock view. Existing suite launches now explicitly choose demo or
the native sunset seam. Frozen package tests belong to Lead C's final checks.
