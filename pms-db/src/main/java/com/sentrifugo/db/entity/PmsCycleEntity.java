package com.sentrifugo.db.entity;


import com.sentrifugo.db.enums.PmsCycleStatus;
import com.sentrifugo.db.enums.PmsCycleType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.UUID;

@Data
@Entity
@Table(
        name = "pms_cycle",
        schema = "pms",
        indexes = {
                @Index(name = "idx_pms_cycle_org", columnList = "organisation_id"),
                @Index(name = "idx_pms_cycle_status", columnList = "status"),
                @Index(name = "idx_pms_cycle_type", columnList = "type"),
                @Index(name = "idx_pms_cycle_period_start", columnList = "period_start"),
                @Index(name = "idx_pms_cycle_created_date", columnList = "created_date"),
                @Index(name = "idx_pms_cycle_rating_scale", columnList = "rating_scale_id")
        }
)
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private UUID organisationId;

    @Column(name = "cycle_code", nullable = false, unique = true, length = 30)
    private String cycleCode;

    @Column(name = "name", nullable = false, length = 200)
    private String name;

    @Column(name = "description", columnDefinition = "TEXT")
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false, length = 20)
    private PmsCycleType type;

    @Column(name = "period_start", nullable = false)
    private LocalDate periodStart;

    @Column(name = "period_end", nullable = false)
    private LocalDate periodEnd;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsCycleStatus status;

    @Column(name = "rating_scale_id")
    private UUID ratingScaleId;

    @Column(name = "notify_managers", nullable = false)
    @Builder.Default
    private Boolean notifyManagers = false;

    @Column(name = "notify_employees", nullable = false)
    @Builder.Default
    private Boolean notifyEmployees = false;

    @Column(name = "notify_hod", nullable = false)
    @Builder.Default
    private Boolean notifyHod = false;

    @Column(name = "notify_hr", nullable = false)
    @Builder.Default
    private Boolean notifyHr = false;

    @Column(name = "current_step", nullable = false)
    @Builder.Default
    private Integer currentStep = 1;

    @Column(name = "completed_step", nullable = false)
    @Builder.Default
    private Integer completedStep = 0;

    @Column(name = "published_on")
    private LocalDateTime publishedOn;
}