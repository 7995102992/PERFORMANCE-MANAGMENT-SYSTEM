package com.sentrifugo.db.enums;

/** Goal state of one employee's assignment, from the manager's side (screens 3.1 - 3.5). */
public enum PmsAssignmentStatus {
    /** Targets saved but not sent. */
    DRAFT,
    /** Validated and sent for the employee to acknowledge. */
    SENT_TO_EMPLOYEE,
    /** Employee acknowledged the targets. */
    ACKNOWLEDGED,
    /** Employee asked for a change. */
    CHANGE_REQUESTED,
    /** Target revision awaiting HOD approval. */
    WITH_HOD,
    /** HOD approved the goals. Progress tracking opens for the employee. */
    APPROVED
}
