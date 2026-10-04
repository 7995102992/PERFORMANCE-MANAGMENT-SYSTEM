package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsCycleStageType;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.util.UUID;

/** Screen 1.3 - one timeline row per stage of a cycle. */
@Entity
@Table(
        name = "pms_cycle_stage",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_pms_cycle_stage_cycle_stage", columnNames = {"cycle_id", "stage"}),
        indexes = {
                @Index(name = "idx_pms_cycle_stage_cycle", columnList = "cycle_id"),
                @Index(name = "idx_pms_cycle_stage_stage", columnList = "stage")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCycleStageEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false)
    private PmsCycleEntity cycle;

    @Enumerated(EnumType.STRING)
    @Column(name = "stage", nullable = false, length = 60)
    private PmsCycleStageType stage;

    @Column(name = "start_date")
    private LocalDate startDate;

    @Column(name = "end_date")
    private LocalDate endDate;

    @Column(name = "notification_enabled", nullable = false)
    @Builder.Default
    private Boolean notificationEnabled = false;
}
