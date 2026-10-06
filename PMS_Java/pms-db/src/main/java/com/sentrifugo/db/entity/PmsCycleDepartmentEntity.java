package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screen 1.4 - a department a cycle applies to. The department master lives in the existing Sentrifugo system. */
@Entity
@Table(
        name = "pms_cycle_department",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_pms_cycle_department_cycle_dept", columnNames = {"cycle_id", "department_id"}),
        indexes = {
                @Index(name = "idx_pms_cycle_department_cycle", columnList = "cycle_id"),
                @Index(name = "idx_pms_cycle_department_dept", columnList = "department_id")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCycleDepartmentEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false)
    private PmsCycleEntity cycle;

    @Column(name = "department_id", nullable = false)
    private String departmentId;
}
