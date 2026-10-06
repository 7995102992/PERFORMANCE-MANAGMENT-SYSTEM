package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.UUID;

/** Screen 2.4 - a competency selected into a goal template, with its weightage. */
@Entity
@Table(
        name = "goal_template_competency",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_goal_template_competency_template_competency", columnNames = {"template_id", "competency_id"}),
        indexes = {
                @Index(name = "idx_goal_template_competency_template", columnList = "template_id"),
                @Index(name = "idx_goal_template_competency_competency", columnList = "competency_id")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsGoalTemplateCompetencyEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "template_id", nullable = false)
    private PmsGoalTemplateEntity template;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "competency_id", nullable = false)
    private PmsCompetencyMasterEntity competency;

    @Column(name = "weightage", nullable = false, precision = 5, scale = 2)
    private BigDecimal weightage;

    @Column(name = "display_order")
    private Integer displayOrder;
}
