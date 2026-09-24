import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { standingCapturedGradingPolicySchema, standingEvidenceSchema, standingLabelsSchema, type StandingEvidenceV1 } from "../shared/standing-evidence";
import { standingEvidenceSchema as serverEvidenceSchema } from "../server/standing-source";
import { canonicalStandingJson, gradingPolicyEvidenceHash } from "../server/standing-policy-provenance";
import { digest } from "../server/security";

function fixture() {
  const orgId=randomUUID(), unitId=randomUUID(), studentId=randomUUID(), yearId=randomUUID(), termId=randomUUID(), sectionId=randomUUID(), courseId=randomUUID();
  const policy={name:"  Synthetic exact policy  ",calculation:"total_points" as const,missing:"exclude" as const,emptyCategories:"renormalize" as const,
    allowExtraCredit:true,capAt100:false,decimals:2,rounding:"nearest" as const,
    categories:[{id:randomUUID(),name:"  Work  ",weight:10000}],scale:[{label:" A ",minimum:9000},{label:" B ",minimum:0}]};
  const projection={schemaVersion:1 as const,kind:"standing_student_release" as const,orgId,unitId,releaseId:randomUUID(),bookId:randomUUID(),bookVersion:7,createdBy:randomUUID(),reviewedAt:"2026-09-23T10:00:00.000Z",
    section:{id:sectionId,courseId},term:{id:termId,yearId},gradingPolicy:{hash:gradingPolicyEvidenceHash(policy),version:1},student:{id:studentId,startsOn:"2026-01-01",endsOn:"2026-12-31"},
    grade:{percentage:"90.00",label:"A",pending:0,missing:0,incomplete:false,hasEvidence:true,provisional:false}};
  const dateFields={starts_on:"2026-01-01",ends_on:"2026-12-31"};
  const parents={student:{id:studentId,name:"Synthetic child",studentNumber:"SYNTHETIC",unitId,version:1,personVersion:1},
    year:{id:yearId,name:"Synthetic year",version:1,...dateFields},terms:[{id:termId,name:"Synthetic term",version:1,...dateFields}],
    enrollment:{id:randomUUID(),version:1,grade_level:"Synthetic",status:"enrolled" as const,...dateFields}};
  const evidence:StandingEvidenceV1={schemaVersion:1,kind:"standing_evidence",issueHash:"1".repeat(64),issuedSourceHash:"2".repeat(64),currentSourceHash:"2".repeat(64),comparisonHash:"3".repeat(64),
    parents:{student:{id:studentId,personId:randomUUID(),version:1,personVersion:1},organization:{id:orgId,name:"Synthetic organization"},unit:{id:unitId,name:"Synthetic unit",version:1},
      card:{id:randomUUID(),version:2,latestIssueId:randomUUID()},issued:parents,current:structuredClone(parents)},matrix:[],
    selectedReleases:[{hash:digest(canonicalStandingJson(projection)),projection,capturedPolicy:policy}],fullCardDependencyUserIds:[projection.createdBy]};
  const labels={studentName:"Synthetic child",studentNumber:"SYNTHETIC",yearName:"Synthetic year",termName:"Synthetic term",organizationName:"Synthetic organization",unitName:"Synthetic unit",
    courses:[{sectionId,courseId,sectionName:"Synthetic class",courseCode:"SYN",courseTitle:"Synthetic course",printDisposition:"excluded" as const,printedExclusionReason:"  Exact recorded reason  "}]};
  return {evidence,labels};
}

test("nested strict evidence parsing preserves raw grading strings and complete hashes",()=>{
  const input=fixture(), before=canonicalStandingJson(input), beforeHash=digest(before);
  const nested=z.object({data:z.object({evidence:standingEvidenceSchema,labels:standingLabelsSchema}).strict()}).strict();
  const parsed=nested.parse({data:input}).data;
  assert.deepEqual(parsed,input);assert.equal(canonicalStandingJson(parsed),before);assert.equal(digest(canonicalStandingJson(parsed)),beforeHash);
  const release=parsed.evidence.selectedReleases[0];
  assert.equal(release.capturedPolicy.name,"  Synthetic exact policy  ");
  assert.equal(release.capturedPolicy.categories[0].name,"  Work  ");assert.equal(release.capturedPolicy.scale[0].label," A ");
  assert.equal(gradingPolicyEvidenceHash(release.capturedPolicy),release.projection.gradingPolicy.hash);
  assert.equal(digest(canonicalStandingJson(release.projection)),release.hash);
  assert.equal(parsed.labels.courses[0].printedExclusionReason,"  Exact recorded reason  ");
  assert.equal(canonicalStandingJson(input),before,"schema parsing must not mutate the source object");
  assert.equal(serverEvidenceSchema,standingEvidenceSchema,"server re-export must share the exact schema");
});

test("raw-preserving policy evidence still applies original grading validation and rejects unknown fields",()=>{
  const original=fixture().evidence.selectedReleases[0].capturedPolicy;
  for(const alter of [
    (policy:any)=>{policy.name="   ";},
    (policy:any)=>{policy.categories.push({id:randomUUID(),name:"Work",weight:0});},
    (policy:any)=>{policy.scale[1].label="A";},
    (policy:any)=>{policy.decimals=3;},
    (policy:any)=>{policy.secret="not allowed";},
    (policy:any)=>{policy.categories[0].unexpected="not allowed";},
    (policy:any)=>{policy.scale[0].unexpected="not allowed";},
  ]){const changed=structuredClone(original);alter(changed);assert.equal(standingCapturedGradingPolicySchema.safeParse(changed).success,false);}
});

test("evidence and label objects reject unknown nested fields and over-bound collections",()=>{
  for(const alter of [
    (value:any)=>{value.evidence.accessToken="not allowed";},
    (value:any)=>{value.evidence.parents.issued.student.email="not allowed";},
    (value:any)=>{value.evidence.selectedReleases[0].projection.grade.otherStudents=[];},
    (value:any)=>{value.evidence.selectedReleases[0].capturedPolicy.secret="not allowed";},
    (value:any)=>{value.evidence.fullCardDependencyUserIds=Array.from({length:401},()=>randomUUID());},
    (value:any)=>{value.labels.courses[0].privateNote="not allowed";},
    (value:any)=>{value.labels.courses=Array.from({length:201},()=>value.labels.courses[0]);},
  ]){const input=fixture();alter(input);assert.equal(z.object({evidence:standingEvidenceSchema,labels:standingLabelsSchema}).strict().safeParse(input).success,false);}
});

test("shared evidence has explicit serializable JSON schemas without opaque acceptance types",()=>{
  const json=z.toJSONSchema(z.object({evidence:standingEvidenceSchema,labels:standingLabelsSchema}).strict());
  const serialized=JSON.stringify(json);
  assert.ok(serialized.includes('"additionalProperties":false'));
  assert.ok(serialized.includes('"capturedPolicy"'));assert.ok(serialized.includes('"provisional"'));
  assert.equal(standingCapturedGradingPolicySchema.safeParse({}).success,false);
});
