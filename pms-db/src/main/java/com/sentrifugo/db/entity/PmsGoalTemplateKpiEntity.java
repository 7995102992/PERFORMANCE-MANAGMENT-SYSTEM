package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsTargetType;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.UUID;

/** Screen 2.3 - a KPI selected into a goal template, with its template-specific weightage and target type. */
@Entity
@Table(
        name = "goal_template_kpi",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_goal_template_kpi_template_kpi", columnNames = {"template_id", "kpi_id"}),
        indexes = {
                @Index(name = "idx_goal_template_kpi_template", columnList = "template_id"),
                @Index(name = "idx_goal_template_kpi_kra", columnList = "kra_id"),
                @Index(name = "idx_goal_template_kpi_kpi", columnList = "kpi_id")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsGoalTemplateKpiEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "template_id", nullable = false)
    private PmsGoalTemplateEntity template;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "kra_id", nullable = false)
    private PmsKraMasterEntity kra;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "kpi_id", nullable = false)
    private PmsKpiMasterEntity kpi;

    @Column(name = "weightage", nullable = false, precision = 5, scale = 2)
    private BigDecimal weightage;

    @Enumerated(EnumType.STRING)
    @Column(name = "target_type", nullable = false, length = 30)
    private PmsTargetType targetType;

    @Column(name = "display_order")
    private Integer displayOrder;
}
