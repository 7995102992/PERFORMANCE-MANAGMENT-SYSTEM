package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsEligibilityRunStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;
import java.util.UUID;

/** Screen 1.6 - outcome of the eligibility processing started when a cycle is published. */
@Entity
@Table(
        name = "pms_cycle_eligibility_run",
        schema = "pms",
        indexes = {
                @Index(name = "idx_pms_cycle_eligibility_run_cycle", columnList = "cycle_id"),
                @Index(name = "idx_pms_cycle_eligibility_run_status", columnList = "status"),
                @Index(name = "idx_pms_cycle_eligibility_run_started", columnList = "started_on")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCycleEligibilityRunEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false)
    private PmsCycleEntity cycle;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsEligibilityRunStatus status;

    @Column(name = "started_on", nullable = false)
    private LocalDateTime startedOn;

    @Column(name = "completed_on")
    private LocalDateTime completedOn;

    @Column(name = "total_eligible", nullable = false)
    @Builder.Default
    private Integer totalEligible = 0;

    @Column(name = "excluded_probation", nullable = false)
    @Builder.Default
    private Integer excludedProbation = 0;

    @Column(name = "excluded_notice_period", nullable = false)
    @Builder.Default
    private Integer excludedNoticePeriod = 0;

    @Column(name = "excluded_min_service", nullable = false)
    @Builder.Default
    private Integer excludedMinService = 0;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;
}
