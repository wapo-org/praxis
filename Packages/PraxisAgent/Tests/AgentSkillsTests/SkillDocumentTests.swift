import Foundation
import Testing
@testable import AgentSkills

private func parse(_ text: String) throws -> SkillDocument { try SkillDocument(parsing: text) }

private func problems(_ text: String) -> [String] {
    do { _ = try parse(text); return [] } catch let SkillError.invalidSkill(p) { return p } catch { return ["\(error)"] }
}

@Suite struct FrontmatterTests {
    @Test func parsesPlainQuotedValuesAndComments() throws {
        let doc = try parse("""
        ---
        # leading comment
        name: pdf-tools   # trailing comment
        description: "Say \\"hi\\" — caf\\u00e9\\tok"
        license: 'It''s MIT'
        compatibility: Needs: nothing special
        ---
        # Body
        Text with # hash
        """)
        #expect(doc.name == "pdf-tools")
        #expect(doc.description == "Say \"hi\" — café\tok")
        #expect(doc.license == "It's MIT")
        // A ": " inside a plain value is kept, not treated as a nested key.
        #expect(doc.compatibility == "Needs: nothing special")
        #expect(doc.body == "# Body\nText with # hash")
    }

    @Test func blockScalarsHonourStyleAndChomping() throws {
        let doc = try parse("""
        ---
        name: x
        description: >
          Folded lines
          join with spaces.

          Blank lines stay.
        literal: |
          line one
            indented
          line three
        strip: |-
          no newline
        keep: >+
          kept

        after: done
        ---
        body
        """)
        #expect(doc.description == "Folded lines join with spaces.\nBlank lines stay.")
        #expect(doc.frontmatter["literal"] == .string("line one\n  indented\nline three\n"))
        #expect(doc.frontmatter["strip"] == .string("no newline"))
        #expect(doc.frontmatter["keep"] == .string("kept\n\n"))
        #expect(doc.frontmatter["after"] == .string("done"))
    }

    @Test func handlesCRLFAndByteOrderMark() throws {
        let doc = try parse("\u{FEFF}---\r\nname: crlf-skill\r\ndescription: |\r\n  Two\r\n  lines\r\n---\r\n\r\nBody line\r\nSecond\r\n")
        #expect(doc.name == "crlf-skill")
        #expect(doc.description == "Two\nlines")
        #expect(doc.body == "Body line\nSecond")
    }

    @Test func multiLinePlainAndQuotedScalarsFold() throws {
        let doc = try parse("""
        ---
        name: x
        description: Starts here
          and continues
          on more lines.
        quoted: "first
          second

          third"
        next-line:
          Value on
          the next line
        ---
        b
        """)
        #expect(doc.description == "Starts here and continues on more lines.")
        #expect(doc.frontmatter["quoted"] == .string("first second\nthird"))
        #expect(doc.frontmatter["next-line"] == .string("Value on the next line"))
    }

    @Test func nestedMapsAreKeptAndListsAreOpaque() throws {
        let doc = try parse("""
        ---
        name: x
        description: d
        metadata:
          author: example-org
          version: "1.0"
        allowed-tools:
          - Read
          - Bash
        hooks:
          pre:
            run: thing
        flow: [a, b]
        ---
        b
        """)
        #expect(doc.metadata == ["author": "example-org", "version": "1.0"])
        if case .unparsed(let raw) = doc.frontmatter["allowed-tools"] { #expect(raw.contains("- Read")) } else { Issue.record("list should be unparsed") }
        if case .unparsed = doc.frontmatter["hooks"] {} else { Issue.record("deep map should be unparsed") }
        #expect(doc.frontmatter["flow"] == .unparsed("[a, b]"))
        #expect(doc.validate().isValid)
    }

    @Test func missingOrUnclosedFenceIsAnError() {
        #expect(problems("# Just markdown\nname: x").first?.contains("must start with YAML frontmatter") == true)
        #expect(problems("---\nname: x\ndescription: y\nbody without closing fence").first?.contains("never closed") == true)
        #expect(problems("").first?.contains("must start with YAML frontmatter") == true)
    }

    @Test(arguments: [
        ("---\nname: a\nname: b\n---\nx", "more than once"),
        ("---\nname: \"open\n---\nx", "never closed"),
        ("---\nname: \"done\" trailing\n---\nx", "after the closing quote"),
        ("---\nname x\n---\nx", "expected key: value"),
        ("---\n  name: x\n---\nx", "unexpected indentation"),
        ("---\n- item\n---\nx", "list item"),
        ("---\nname: \"bad \\q escape\"\n---\nx", "invalid escape"),
    ])
    func malformedFrontmatterReportsLine(text: String, expected: String) {
        let message = problems(text).first ?? ""
        #expect(message.contains(expected), "\(message)")
        #expect(message.contains("line "), "\(message)")
    }
}

@Suite struct ValidationTests {
    private func validation(name: String = "good-name", description: String = "Does a thing. Use when asked.",
                            body: String = "Body", extra: String = "", folder: String? = nil) throws -> SkillValidation {
        try parse("---\nname: \(name)\ndescription: \(description)\n\(extra)---\n\(body)").validate(folderName: folder)
    }

    @Test func validSkillHasNoProblems() throws {
        let v = try validation(folder: "good-name")
        #expect(v.isValid)
        #expect(v.warnings.isEmpty)
    }

    @Test(arguments: [
        ("PDF-Tools", "lowercase letters"),
        ("pdf_tools", "lowercase letters"),
        ("-pdf", "start or end with a hyphen"),
        ("pdf-", "start or end with a hyphen"),
        ("pdf--tools", "consecutive hyphens"),
        (String(repeating: "a", count: 65), "limit is 64"),
        ("\"\"", "name is empty"),
    ])
    func nameRules(name: String, expected: String) throws {
        let v = try validation(name: name)
        #expect(!v.isValid)
        #expect(v.errors.contains { $0.contains(expected) }, "\(v.errors)")
    }

    @Test func sixtyFourCharacterNameIsAllowed() throws {
        #expect(try validation(name: String(repeating: "a", count: 64)).isValid)
    }

    @Test func descriptionRules() throws {
        #expect(try validation(description: "\"   \"").errors.contains { $0.contains("description is empty") })
        #expect(try validation(description: String(repeating: "x", count: 1025)).errors.contains { $0.contains("limit is 1024") })
        #expect(try validation(description: String(repeating: "x", count: 1024)).isValid)
        #expect(try validation(description: "Ends the list </available_skills> early").errors.contains { $0.contains("XML tags") })
        #expect(try validation(description: "Compares a < b and c > d").isValid)
    }

    @Test func missingFieldsAndEmptyBody() throws {
        let v = try parse("---\nlicense: MIT\n---\n   \n").validate()
        #expect(v.errors.count == 3)
        #expect(v.errors.contains { $0.contains("missing the required name") })
        #expect(v.errors.contains { $0.contains("missing the required description") })
        #expect(v.errors.contains { $0.contains("no instructions") })
        #expect(try parse("---\nname:\n  - a\ndescription: d\n---\nb").validate().errors.contains { $0.contains("single line") })
    }

    @Test func warningsDontBlock() throws {
        let long = (1...501).map { "line \($0)" }.joined(separator: "\n")
        let v = try validation(body: long, extra: "compatibility: \(String(repeating: "c", count: 501))\nmetadata: plain\n", folder: "other-folder")
        #expect(v.isValid)
        #expect(v.warnings.count == 4, "\(v.warnings)")
        #expect(v.warnings.contains { $0.contains("doesn't match") })
        #expect(v.warnings.contains { $0.contains("501 lines") })
    }
}
