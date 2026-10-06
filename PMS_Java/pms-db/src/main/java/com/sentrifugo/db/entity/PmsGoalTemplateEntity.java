package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsTemplateStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.util.UUID;

/** Screens 2.1 and 2.2 - a role-based goal template. Department, role and plant ids belong to the existing Sentrifugo system. */
@Entity
@Table(
        name = "goal_template",
        schema = "pms",
        indexes = {
                @Index(name = "idx_goal_template_org", columnList = "organisation_id"),
                @Index(name = "idx_goal_template_fy", columnList = "financial_year"),
                @Index(name = "idx_goal_template_department", columnList = "department_id"),
                @Index(name = "idx_goal_template_role", columnList = "role_id"),
                @Index(name = "idx_goal_template_plant", columnList = "plant_id"),
                @Index(name = "idx_goal_template_status", columnList = "status"),
                @Index(name = "idx_goal_template_effective_from", columnList = "effective_from")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsGoalTemplateEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    @Column(name = "financial_year", nullable = false, length = 20)
    private String financialYear;

    @Column(name = "template_name", nullable = false, length = 200)
    private String templateName;

    @Column(name = "description", columnDefinition = "TEXT")
    private String description;

    @Column(name = "department_id", nullable = false)
    private String departmentId;

    @Column(name = "role_id", nullable = false)
    private String roleId;

    /** Shown on screen 2.1; may be derived from role/department. */
    @Column(name = "plant_id")
    private String plantId;

    @Column(name = "effective_from", nullable = false)
    private LocalDate effectiveFrom;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsTemplateStatus status;
}
