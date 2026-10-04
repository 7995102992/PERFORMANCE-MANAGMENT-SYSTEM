package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleEmploymentTypeEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsCycleEmploymentTypeRepository extends JpaRepository<PmsCycleEmploymentTypeEntity, UUID> {
}
