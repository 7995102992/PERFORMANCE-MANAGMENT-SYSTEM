package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screen 2.3 - a KRA selected into a goal template. */
@Entity
@Table(
        name = "goal_template_kra",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_goal_template_kra_template_kra", columnNames = {"template_id", "kra_id"}),
        indexes = {
                @Index(name = "idx_goal_template_kra_template", columnList = "template_id"),
                @Index(name = "idx_goal_template_kra_kra", columnList = "kra_id")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsGoalTemplateKraEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "template_id", nullable = false)
    private PmsGoalTemplateEntity template;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "kra_id", nullable = false)
    private PmsKraMasterEntity kra;

    @Column(name = "display_order")
    private Integer displayOrder;
}
