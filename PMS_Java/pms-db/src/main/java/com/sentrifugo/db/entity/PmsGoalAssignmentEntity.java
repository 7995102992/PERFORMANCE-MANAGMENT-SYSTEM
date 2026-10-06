package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsAssignmentStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;
import java.util.UUID;

/**
 * One manager's goal assignment to one employee for one financial year: the targets the
 * manager set, and where they stand. Created on the first save; employees with no row are
 * "Not Started".
 */
@Entity
@Table(
        name = "goal_assignment",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_goal_assignment_employee_fy",
                columnNames = {"organisation_id", "employee_user_id", "financial_year"}),
        indexes = {
                @Index(name = "idx_goal_assignment_manager", columnList = "manager_user_id"),
                @Index(name = "idx_goal_assignment_status", columnList = "status")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsGoalAssignmentEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    /** IAM user id of the employee being assigned goals. */
    @Column(name = "employee_user_id", nullable = false)
    private String employeeUserId;

    /** IAM user id of the manager who set the targets. */
    @Column(name = "manager_user_id", nullable = false)
    private String managerUserId;

    @Column(name = "financial_year", nullable = false, length = 20)
    private String financialYear;

    /** The goal template the targets were set against. */
    @Column(name = "template_id", nullable = false)
    private UUID templateId;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 30)
    private PmsAssignmentStatus status;

    @Column(name = "sent_on")
    private LocalDateTime sentOn;

    /** Snapshot of the employee's details, so the HOD list needs no IAM lookup. */
    @Column(name = "employee_name", length = 200)
    private String employeeName;

    @Column(name = "emp_code", length = 50)
    private String empCode;

    @Column(name = "designation_name", length = 200)
    private String designationName;

    @Column(name = "acknowledged_on")
    private LocalDateTime acknowledgedOn;

    /** Employee's change request: which KPI, why, and the target they propose. */
    @Column(name = "change_kpi_id")
    private UUID changeKpiId;

    @Column(name = "change_reason", columnDefinition = "TEXT")
    private String changeReason;

    @Column(name = "change_proposed_target", precision = 14, scale = 2)
    private java.math.BigDecimal changeProposedTarget;

    @Column(name = "change_requested_on")
    private LocalDateTime changeRequestedOn;

    @Column(name = "hod_remarks", columnDefinition = "TEXT")
    private String hodRemarks;

    @Column(name = "approved_on")
    private LocalDateTime approvedOn;
}
