package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.util.UUID;

/** Screen 1.4 - who a cycle covers (one row per cycle). Plants, departments and employment types are child tables. */
@Entity
@Table(name = "pms_cycle_applicability", schema = "pms")
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCycleApplicabilityEntity extends BaseEntity<UUID> {

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false, unique = true)
    private PmsCycleEntity cycle;

    @Column(name = "all_plants", nullable = false)
    @Builder.Default
    private Boolean allPlants = false;

    @Column(name = "all_departments", nullable = false)
    @Builder.Default
    private Boolean allDepartments = true;

    @Column(name = "minimum_service_months")
    private Integer minimumServiceMonths;

    @Column(name = "service_calculated_as_on")
    private LocalDate serviceCalculatedAsOn;

    @Column(name = "exclude_probation", nullable = false)
    @Builder.Default
    private Boolean excludeProbation = false;

    @Column(name = "exclude_notice_period", nullable = false)
    @Builder.Default
    private Boolean excludeNoticePeriod = false;
}
